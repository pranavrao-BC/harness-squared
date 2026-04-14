// Job lifecycle + in-memory store. Glues executor sessions to h2 Jobs,
// bridges executor events to per-job event hubs, and decides when a Job
// transitions to `done`/`error`.
//
// Backend-agnostic: depends only on the ExecutorAdapter interface, never on
// opencode/gemini specifics.

import type { Config, Event, Job, JobState, Plan, PermissionResponse } from "../shared/types.ts";
import type { ExecutorAdapter, NormalizedMessage, NormalizedPart } from "./executor/types.ts";
import { log } from "../shared/log.ts";
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
  private jobAdapters = new Map<string, ExecutorAdapter>();
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: Config,
    private adapters: ReadonlyMap<string, ExecutorAdapter>,
    public permissions: PermissionStore,
  ) {}

  /** Start the dispatch loop. Called once on daemon boot. */
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

  private resolveAdapter(executorName?: string): ExecutorAdapter {
    const name = executorName ?? this.config.defaultExecutor;
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`unknown executor: ${name}`);
    return adapter;
  }

  /** Dispatch a pending job: create session, subscribe to events, fire prompt. */
  private async dispatch(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.state !== "pending") return;
    const adapter = this.resolveAdapter(job.executor);
    // Mark running immediately so the next tick doesn't double-dispatch.
    this.mergeJob(id, { state: "running", updatedAt: new Date().toISOString() });
    log.info("dispatch", { id, executor: adapter.name, task: firstLine(job.task, 60) });
    try {
      const sessionId = await adapter.createSession(firstLine(job.task, 60));
      this.mergeJob(id, { sessionId });
      this.jobAdapters.set(id, adapter);

      const hub = new JobEventHub();
      this.hubs.set(id, hub);

      const unsub = adapter.subscribe(sessionId, (events, rawType) => {
        for (const ev of events) this.handleEvent(id, ev, rawType);
        this.handleRaw(id, adapter, rawType);
      });
      this.unsubscribers.set(id, unsub);

      await adapter.prompt(sessionId, job.task);
      // State already set to "running" above; publish the status event for subscribers.
      this.hubs.get(id)?.publish({ type: "status", state: "running" });
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

  /** Create a single job and dispatch it immediately. */
  async create(task: string, executor?: string): Promise<Job> {
    const job: Job = {
      id: jobId(),
      task,
      sessionId: "", // filled by dispatch
      executor: executor ?? this.config.defaultExecutor,
      state: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    await this.dispatch(job.id);
    return this.jobs.get(job.id)!;
  }

  /** Create a plan: N jobs with optional dependency edges. */
  createPlan(
    tasks: Array<{ task: string; deps?: string[]; executor?: string }>,
  ): Plan {
    const planId = "plan_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const localIds: string[] = [];
    for (const t of tasks) {
      const id = jobId();
      localIds.push(id);
      const job: Job = {
        id,
        task: t.task,
        sessionId: "",
        executor: t.executor ?? this.config.defaultExecutor,
        state: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        planId,
      };
      this.jobs.set(id, job);
    }
    for (let i = 0; i < tasks.length; i++) {
      const depIndices = tasks[i].deps ?? [];
      const depIds = depIndices
        .map((d) => {
          const idx = typeof d === "number" ? d : parseInt(d, 10);
          return isNaN(idx) ? d : localIds[idx];
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
        const store = this.partStore(jobId);
        store.set(ev.partId, ev.text);
        this.finalBuffers.set(jobId, [...store.values()].join("\n\n"));
        hub.publish(ev);
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
        return;
      }
      case "job.done":
        return;
      case "log":
        hub.publish(ev);
        return;
    }
  }

  /** Called for every raw executor event. Uses adapter's signal declarations
   *  to decide state transitions (backend-agnostic). */
  private handleRaw(jobId: string, adapter: ExecutorAdapter, rawType: string) {
    const j = this.jobs.get(jobId);
    if (!j) return;
    const hub = this.hubs.get(jobId);

    // Re-activate: if we see activity on a terminal job, the user continued
    // the session outside of h2. Flip back to running.
    if (adapter.activeSignals.includes(rawType)) {
      if ((j.state === "done" || j.state === "error" || j.state === "stopped") && hub) {
        hub.clearBuffer();
        this.mergeJob(jobId, { state: "running", error: undefined, updatedAt: new Date().toISOString() });
        hub.publish({ type: "status", state: "running" });
        log.info("job re-activated by session activity", { jobId });
      }
      return;
    }

    if (!adapter.idleSignals.includes(rawType)) return;
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
    const adapter = this.jobAdapters.get(id) ?? this.resolveAdapter(j.executor);
    if (!this.unsubscribers.has(id)) {
      const unsub = adapter.subscribe(j.sessionId, (events, rawType) => {
        for (const ev of events) this.handleEvent(id, ev, rawType);
        this.handleRaw(id, adapter, rawType);
      });
      this.unsubscribers.set(id, unsub);
    }
    await adapter.prompt(j.sessionId, content);
    this.hubs.get(id)?.clearBuffer();
    this.mergeJob(id, { error: undefined });
    this.setState(id, "running");
  }

  async respondPermission(id: string, permId: string, response: PermissionResponse): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) throw new Error("no such job");
    const adapter = this.jobAdapters.get(id) ?? this.resolveAdapter(j.executor);
    await adapter.respondPermission(j.sessionId, permId, response);
    // Mark resolved immediately. Opencode also emits permission.replied which
    // would double-resolve via handleEvent, but that's harmless.
    this.permissions.resolve(id, permId, response);
    this.hubs.get(id)?.publish({ type: "permission.resolved", id: permId, response });
  }

  async abort(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) throw new Error("no such job");
    const adapter = this.jobAdapters.get(id) ?? this.resolveAdapter(j.executor);
    await adapter.abort(j.sessionId);
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

  /** Condensed conversation log for the orchestrator. */
  async sessionLog(id: string, full = false): Promise<string | null> {
    const j = this.jobs.get(id);
    if (!j) return null;
    const adapter = this.jobAdapters.get(id) ?? this.resolveAdapter(j.executor);
    try {
      const msgs = await adapter.listMessages(j.sessionId);
      if (msgs.length > 0) return renderSessionLog(msgs, full);
      // No messages from adapter — use buffered output from events
      return this.finalBuffers.get(id) ?? j.finalOutput ?? null;
    } catch (e) {
      log.warn("jobs: sessionLog fetch failed", { err: String(e) });
      return this.finalBuffers.get(id) ?? j.finalOutput ?? null;
    }
  }
}

function jobId(): string {
  return "job_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function firstLine(s: string, max: number): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "\u2026" : line;
}

/** Render a normalised message list into the condensed log format. */
function renderSessionLog(msgs: readonly NormalizedMessage[], full: boolean): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    const role = msg.role;
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
          if (part.status === "completed") {
            if (full && part.output !== undefined) {
              lines.push(`[tool \u2713] ${part.tool} \u2192 ${truncate(String(part.output), 120)}`);
            } else {
              lines.push(`[tool \u2713] ${part.tool}`);
            }
          } else if (part.status === "error") {
            lines.push(`[tool \u2717] ${part.tool} ${truncate(part.error ?? "", 80)}`);
          } else if (full && part.input !== undefined) {
            lines.push(`[tool] ${part.tool} ${truncate(JSON.stringify(part.input), 100)}`);
          }
          break;
        }
        default:
          break;
      }
    }
    if (msg.error) {
      lines.push(`[error] ${msg.error}`);
    }
  }
  // Hoist [ESCALATE] blocks to the top.
  const escalations: string[] = [];
  const rest: string[] = [];
  for (const line of lines) {
    if (/\[ESCALATE\]/i.test(line)) escalations.push(line);
    else rest.push(line);
  }
  if (escalations.length > 0) {
    return ["--- ESCALATIONS ---", ...escalations, "--- LOG ---", ...rest].join("\n");
  }
  return rest.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}
