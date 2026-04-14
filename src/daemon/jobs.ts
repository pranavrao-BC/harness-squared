// Job lifecycle + in-memory store. Glues opencode sessions to h2 Jobs,
// bridges opencode events to per-job event hubs, and decides when a Job
// transitions to `done`/`error`.

import type { Config, Event, Job, JobState, Plan, PermissionResponse } from "../shared/types.ts";
import { log } from "../shared/log.ts";
import { OpencodeClient, type OcMessageRow } from "./opencode_client.ts";
import { OpencodeEventBridge } from "./opencode_events.ts";
import { JobEventHub } from "./events.ts";
import { PermissionStore } from "./permissions.ts";
import { appendHistory } from "./history.ts";
export { readHistory, type HistoryEntry } from "./history.ts";

const MAX_CONCURRENT = 3;
const DISPATCH_INTERVAL_MS = 2000;

export class JobManager {
  private jobs = new Map<string, Job>();
  private plans = new Map<string, Plan>();
  private hubs = new Map<string, JobEventHub>();
  private unsubscribers = new Map<string, () => void>();
  private finalBuffers = new Map<string, string>();
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: Config,
    private client: OpencodeClient,
    private bridge: OpencodeEventBridge,
    public permissions: PermissionStore,
  ) {}

  /** Start the Symphony-style dispatch loop. Called once on daemon boot. */
  startDispatchLoop() {
    if (this.dispatchTimer) return;
    this.dispatchTimer = setInterval(() => this.tick(), DISPATCH_INTERVAL_MS);
  }

  stopDispatchLoop() {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
  }

  /** One dispatch tick: find pending jobs whose deps are met, dispatch up to concurrency limit. */
  private async tick() {
    const running = [...this.jobs.values()].filter((j) => j.state === "running").length;
    const slots = MAX_CONCURRENT - running;
    if (slots <= 0) return;

    const eligible = [...this.jobs.values()]
      .filter((j) => j.state === "pending" && this.depsCleared(j))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const job of eligible.slice(0, slots)) {
      await this.dispatch(job.id);
    }
  }

  private depsCleared(job: Job): boolean {
    if (!job.deps || job.deps.length === 0) return true;
    return job.deps.every((depId) => {
      const dep = this.jobs.get(depId);
      return dep && dep.state === "done";
    });
  }

  /** Dispatch a pending job: create session, subscribe to events, fire prompt. */
  private async dispatch(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    log.info("dispatch", { id, task: firstLine(job.task, 60) });
    try {
      const session = await this.client.createSession(firstLine(job.task, 60));
      this.mergeJob(id, { sessionId: session.id });

      const hub = new JobEventHub();
      this.hubs.set(id, hub);

      const unsub = this.bridge.subscribe(session.id, (events, raw) => {
        for (const ev of events) this.handleEvent(id, ev, raw.type);
        this.handleRaw(id, raw.type);
      });
      this.unsubscribers.set(id, unsub);

      await this.client.promptAsync(session.id, job.task);
      this.setState(id, "running");
    } catch (e) {
      log.error("dispatch failed", { id, err: String(e) });
      this.mergeJob(id, { state: "error", error: String(e), updatedAt: new Date().toISOString() });
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getHub(id: string): JobEventHub | undefined {
    return this.hubs.get(id);
  }

  /** Create a single job and dispatch it immediately (the original h2 delegate path). */
  async create(task: string): Promise<Job> {
    const job: Job = {
      id: jobId(),
      task,
      sessionId: "", // filled by dispatch
      state: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    await this.dispatch(job.id);
    return this.jobs.get(job.id)!;
  }

  /** Create a plan: N jobs with optional dependency edges. Jobs start in "pending"
   *  and the dispatch loop picks them up as deps clear. */
  createPlan(tasks: Array<{ task: string; deps?: string[] }>): Plan {
    const planId = "plan_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    // First pass: create all jobs so we can map local indices to job IDs.
    const localIds: string[] = [];
    for (const t of tasks) {
      const id = jobId();
      localIds.push(id);
      const job: Job = {
        id,
        task: t.task,
        sessionId: "",
        state: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        planId,
      };
      this.jobs.set(id, job);
    }
    // Second pass: wire up deps. Deps reference indices (0-based) into the tasks array.
    for (let i = 0; i < tasks.length; i++) {
      const depIndices = tasks[i].deps ?? [];
      const depIds = depIndices
        .map((d) => {
          const idx = typeof d === "number" ? d : parseInt(d, 10);
          return isNaN(idx) ? d : localIds[idx]; // support both index and raw job id
        })
        .filter(Boolean) as string[];
      if (depIds.length > 0) {
        this.mergeJob(localIds[i], { deps: depIds });
      }
    }
    const plan: Plan = { id: planId, jobIds: localIds, createdAt: new Date().toISOString() };
    this.plans.set(planId, plan);
    log.info("plan created", { planId, count: tasks.length });
    return plan;
  }

  getPlan(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  listPlans(): Plan[] {
    return [...this.plans.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private handleEvent(jobId: string, ev: Event, _rawType: string) {
    const hub = this.hubs.get(jobId);
    if (!hub) return;

    switch (ev.type) {
      case "permission.request": {
        // Fix jobId — bridge doesn't know h2 ids, it stamped sessionId.
        const req = { ...ev.request, jobId };
        this.permissions.record(jobId, req);
        hub.publish({ type: "permission.request", request: req });
        return;
      }
      case "permission.resolved": {
        const response: PermissionResponse = ev.response === "always"
          ? "always"
          : ev.response === "once"
          ? "once"
          : "reject";
        this.permissions.resolve(jobId, ev.id, response);
        hub.publish({ type: "permission.resolved", id: ev.id, response });
        return;
      }
      case "assistant.delta": {
        const prev = this.finalBuffers.get(jobId) ?? "";
        // Strategy: keep the latest text per partId by appending the full part
        // text each time (message.part.updated sends cumulative text). We
        // de-dup by tracking a map from partId→text and recomputing buffer.
        const store = this.partStore(jobId);
        store.set(ev.partId, ev.text);
        this.finalBuffers.set(jobId, [...store.values()].join("\n\n"));
        // Pass through to subscribers with the delta-ish semantics.
        hub.publish(ev);
        // `prev` unused, just keeping intent visible.
        void prev;
        return;
      }
      case "tool.use":
      case "tool.result":
        hub.publish(ev);
        return;
      case "status":
        hub.publish(ev);
        return;
      case "job.error": {
        const state: JobState = "error";
        this.mergeJob(jobId, { state, updatedAt: new Date().toISOString(), error: ev.error });
        hub.publish({ type: "status", state });
        hub.publish(ev);
        appendHistory(this.jobs.get(jobId)!);
        // Do NOT teardown. Error is a state, not a grave — the user may
        // resume the session via `h2 send`, and we need to keep listening
        // for subsequent opencode events (session.idle, new parts, etc.).
        return;
      }
      case "job.done":
        // We synthesise this below rather than receiving from bridge.
        return;
      case "log":
        hub.publish(ev);
        return;
    }

  }

  /** Called for every raw opencode event on the subscribed session, after
   *  translated events have been handled. Handles two transitions:
   *  1. session.idle → mark job done (if running)
   *  2. session.status busy → re-activate a finished/errored job (user continued in TUI)
   */
  private handleRaw(jobId: string, rawType: string) {
    const j = this.jobs.get(jobId);
    if (!j) return;
    const hub = this.hubs.get(jobId);

    // Re-activate: if we see activity on a terminal job, the user continued
    // the session outside of h2. Flip back to running.
    if (rawType === "session.status") {
      if ((j.state === "done" || j.state === "error" || j.state === "stopped") && hub) {
        // We can't easily inspect the status payload here (it was already
        // consumed by translate), but any session.status on a terminal job
        // means opencode is doing something. Mark running.
        this.mergeJob(jobId, { state: "running", error: undefined, updatedAt: new Date().toISOString() });
        hub.publish({ type: "status", state: "running" });
        log.info("job re-activated by session activity", { jobId });
      }
      return;
    }

    if (rawType !== "session.idle") return;
    if (j.state !== "running") return;
    if (!hub) return;
    const finalOutput = this.finalBuffers.get(jobId) ?? "";
    this.mergeJob(jobId, {
      state: "done",
      updatedAt: new Date().toISOString(),
      finalOutput,
    });
    hub.publish({ type: "status", state: "done" });
    hub.publish({ type: "job.done", summary: firstLine(finalOutput, 120) });
    appendHistory(this.jobs.get(jobId)!, firstLine(finalOutput, 200));
    // Do NOT teardown — user may continue the session via opencode TUI/web,
    // and we want to stay subscribed so the job re-activates.
  }

  private partBuffers = new Map<string, Map<string, string>>();
  private partStore(jobId: string): Map<string, string> {
    let m = this.partBuffers.get(jobId);
    if (!m) {
      m = new Map();
      this.partBuffers.set(jobId, m);
    }
    return m;
  }

  private setState(id: string, state: JobState) {
    this.mergeJob(id, { state, updatedAt: new Date().toISOString() });
    const hub = this.hubs.get(id);
    hub?.publish({ type: "status", state });
  }

  private mergeJob(id: string, patch: Partial<Job>) {
    const j = this.jobs.get(id);
    if (!j) return;
    this.jobs.set(id, { ...j, ...patch });
  }

  async sendMessage(id: string, content: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) throw new Error("no such job");
    // Allow send on ANY state — done/error/stopped all re-activate the session.
    // Re-subscribe if we previously tore down (e.g. abort).
    if (!this.unsubscribers.has(id)) {
      const unsub = this.bridge.subscribe(j.sessionId, (events, raw) => {
        for (const ev of events) this.handleEvent(id, ev, raw.type);
        this.handleRaw(id, raw.type);
      });
      this.unsubscribers.set(id, unsub);
    }
    await this.client.promptAsync(j.sessionId, content);
    this.mergeJob(id, { error: undefined }); // clear old error
    this.setState(id, "running");
  }

  async respondPermission(id: string, permId: string, response: PermissionResponse): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) throw new Error("no such job");
    await this.client.respondPermission(j.sessionId, permId, response);
    // The opencode server will emit permission.replied; handleEvent will mark resolved.
  }

  async abort(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) throw new Error("no such job");
    await this.client.abortSession(j.sessionId);
    this.mergeJob(id, { state: "stopped", updatedAt: new Date().toISOString() });
    this.hubs.get(id)?.publish({ type: "status", state: "stopped" });
    this.teardown(id);
  }

  private teardown(id: string) {
    const unsub = this.unsubscribers.get(id);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(id);
    }
  }

  /** Condensed conversation log for the orchestrator. Includes user messages
   *  (showing mid-run steering), tool calls, errors, and final assistant text. */
  async sessionLog(id: string, full = false): Promise<string | null> {
    const j = this.jobs.get(id);
    if (!j) return null;
    try {
      const msgs = await this.client.listMessages(j.sessionId);
      return renderSessionLog(msgs, full);
    } catch (e) {
      log.warn("jobs: sessionLog fetch failed", { err: String(e) });
      return this.finalBuffers.get(id) ?? null;
    }
  }
}

function jobId(): string {
  return "job_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function firstLine(s: string, max: number): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function renderSessionLog(msgs: OcMessageRow[], full: boolean): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    const role = msg.info.role;
    const err = msg.info.error;
    for (const part of msg.parts) {
      switch (part.type) {
        case "text": {
          if (part.synthetic) break;
          const prefix = role === "user" ? "[user]" : "[assistant]";
          const text = full ? part.text : truncate(part.text, 200);
          if (text.trim()) lines.push(`${prefix} ${text}`);
          break;
        }
        case "tool": {
          const t = part as { tool: string; callID: string; state: unknown };
          const st = t.state as Record<string, unknown> | undefined;
          const status = st && typeof st === "object" && "status" in st
            ? String((st as { status: unknown }).status)
            : undefined;
          if (status === "completed") {
            if (full && st && "output" in st) {
              lines.push(`[tool ✓] ${t.tool} → ${truncate(String((st as { output: unknown }).output), 120)}`);
            } else {
              lines.push(`[tool ✓] ${t.tool}`);
            }
          } else if (status === "error") {
            const e = st && "error" in st ? String((st as { error: unknown }).error) : "";
            lines.push(`[tool ✗] ${t.tool} ${truncate(e, 80)}`);
          } else if (status === "running" || !status) {
            // In-progress or pending — show the tool name + input summary in full mode.
            if (full && st && "input" in st) {
              lines.push(`[tool] ${t.tool} ${truncate(JSON.stringify((st as { input: unknown }).input), 100)}`);
            }
          }
          break;
        }
        default:
          break;
      }
    }
    if (err) {
      lines.push(`[error] ${err.name}: ${err.data?.message ?? ""}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
