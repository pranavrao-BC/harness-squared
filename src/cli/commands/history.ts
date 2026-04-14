// Shows past job history from the persistent JSONL log.
import { ipcGet } from "../ipc.ts";
import { color } from "../format.ts";

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

export async function cmdHistory(args: string[]): Promise<number> {
  const limit = parseInt(args.find((a) => /^\d+$/.test(a)) ?? "20", 10);
  const entries = await ipcGet<HistoryEntry[]>(`/history?limit=${limit}`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    console.log("(no history)");
    return 0;
  }
  for (const e of entries) {
    const stateColor = e.state === "done" ? color.green : e.state === "error" ? color.red : color.yellow;
    const plan = e.planId ? ` ${color.dim}plan:${e.planId.slice(-6)}${color.reset}` : "";
    console.log(
      `${color.dim}${e.finishedAt.slice(0, 16)}${color.reset}  ${stateColor}${e.state.padEnd(7)}${color.reset}  ${e.task.slice(0, 70)}${plan}`,
    );
    if (e.error) console.log(`  ${color.red}${e.error.slice(0, 100)}${color.reset}`);
    if (e.summary) console.log(`  ${color.dim}${e.summary.slice(0, 100)}${color.reset}`);
  }
  return 0;
}
