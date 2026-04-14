// Blocks until a job reaches a terminal state (done/error/stopped), then prints the result.
import { ipcFetch, ipcGet } from "../ipc.ts";
import { parseSse } from "../../shared/sse.ts";
import type { Event, Job } from "../../shared/types.ts";

export async function cmdWait(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: h2 wait <job-id>");
    return 2;
  }

  // Check if already terminal.
  const job = await ipcGet<Job>(`/jobs/${id}`);
  if (isTerminal(job.state)) {
    return printResult(job);
  }

  // Subscribe to SSE and block until terminal.
  const res = await ipcFetch("GET", `/jobs/${id}/events`, { stream: true });
  if (res.status !== 200) {
    const txt = await res.text();
    console.error(`error: ${txt}`);
    return 1;
  }

  try {
    for await (const frame of parseSse(res.stream())) {
      let ev: Event;
      try {
        ev = JSON.parse(frame.data) as Event;
      } catch {
        continue;
      }
      if (ev.type === "status" && isTerminal(ev.state)) break;
      if (ev.type === "job.done" || ev.type === "job.error") break;
    }
  } catch { /* stream closed */ }

  // Fetch final state.
  const final = await ipcGet<Job>(`/jobs/${id}`);
  return printResult(final);
}

function isTerminal(state: string): boolean {
  return state === "done" || state === "error" || state === "stopped";
}

function printResult(job: Job): number {
  console.log(`${job.id}  ${job.state}`);
  if (job.error) console.error(`error: ${job.error}`);
  return job.state === "done" ? 0 : 1;
}
