// Executes a JS script with the h2 API injected. The script runs in-process
// as an async function — no temp files, no deno subprocess, works compiled.
import { ipcGet, ipcPost, ipcFetch } from "../ipc.ts";
import { parseSse } from "../../shared/sse.ts";
import type { Job, Plan } from "../../shared/types.ts";

type HistoryEntry = {
  jobId: string;
  planId?: string;
  sessionId: string;
  task: string;
  state: string;
  error?: string;
  summary?: string;
  createdAt: string;
  finishedAt: string;
};

type DelegateOpts = { executor?: string; cwd?: string; model?: string };
type RunOpts = { executor?: string; full?: boolean; cwd?: string; model?: string };

function buildH2Api() {
  return {
    /** Standard suffix appended by delegate/run to tell the executor about escalation. */
    ESCALATE_INSTRUCTION: `\n\nIf you discover anything the orchestrator should know — breaking changes, missing dependencies, design concerns, ambiguities, or blockers — include it in your response prefixed with [ESCALATE]. Example: "[ESCALATE] The Job type is missing a planId field needed for dependency tracking." These will be surfaced to the orchestrator before the rest of the log.`,

    async delegate(task: string, opts?: DelegateOpts): Promise<string> {
      const body: Record<string, unknown> = { task: task + this.ESCALATE_INSTRUCTION };
      body.cwd = opts?.cwd ?? Deno.cwd();
      if (opts?.executor) body.executor = opts.executor;
      if (opts?.model) body.model = opts.model;
      const res = await ipcPost<{ id: string }>("/jobs", body);
      return res.id;
    },

    async wait(id: string): Promise<{ id: string; state: string }> {
      const job = await ipcGet<Job>(`/jobs/${id}`);
      if (isTerminal(job.state)) return { id: job.id, state: job.state };
      const res = await ipcFetch("GET", `/jobs/${id}/events`, { stream: true });
      if (res.status !== 200) {
        return { id, state: "error" };
      }
      try {
        for await (const frame of parseSse(res.stream())) {
          try {
            const ev = JSON.parse(frame.data);
            if (ev.type === "status" && isTerminal(ev.state)) break;
            if (ev.type === "job.done" || ev.type === "job.error") break;
          } catch { /* skip bad frames */ }
        }
      } catch { /* stream closed */ }
      const final = await ipcGet<Job>(`/jobs/${id}`);
      return { id: final.id, state: final.state };
    },

    async output(id: string, opts?: { full?: boolean }): Promise<string> {
      const suffix = opts?.full ? "?full=1" : "";
      const res = await ipcGet<{ text: string }>(`/jobs/${id}/output${suffix}`);
      return res.text;
    },

    async send(id: string, message: string): Promise<void> {
      await ipcPost<{ ok: boolean }>(`/jobs/${id}/messages`, { content: message });
    },

    async abort(id: string): Promise<void> {
      await ipcPost<{ ok: boolean }>(`/jobs/${id}/stop`);
    },

    async status(id: string): Promise<Job> {
      return await ipcGet<Job>(`/jobs/${id}`);
    },

    async plan(
      tasks: Array<{ task: string; deps?: (string | number)[]; executor?: string }>,
    ): Promise<{ planId: string; jobIds: string[] }> {
      const res = await ipcPost<Plan>("/plans", { tasks });
      return { planId: res.id, jobIds: res.jobIds };
    },

    async history(limit = 20): Promise<HistoryEntry[]> {
      return await ipcGet<HistoryEntry[]>(`/history?limit=${limit}`);
    },

    /** Delegate + wait + output in one shot. Convenience for simple tasks. */
    async run(task: string, opts?: RunOpts): Promise<string> {
      const id = await this.delegate(task, { executor: opts?.executor, cwd: opts?.cwd, model: opts?.model });
      await this.wait(id);
      return await this.output(id, { full: opts?.full });
    },
  };
}

function isTerminal(state: string): boolean {
  return state === "done" || state === "error" || state === "stopped";
}

export async function cmdExec(args: string[]): Promise<number> {
  let script: string;
  if (args.length > 0 && args[0] !== "-") {
    script = args.join(" ");
  } else {
    script = await readStdin();
  }

  if (!script.trim()) {
    console.error("usage: h2 exec '<script>' or echo '<script>' | h2 exec");
    return 2;
  }

  const h2 = buildH2Api();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  try {
    const fn = new AsyncFunction("h2", script);
    await fn(h2);
    return 0;
  } catch (e) {
    console.error(`exec error: ${e}`);
    if ((e as Error).stack) console.error((e as Error).stack);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}
