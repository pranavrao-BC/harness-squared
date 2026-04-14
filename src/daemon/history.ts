// Append-only JSONL history log. One line per job terminal state.
// Lives at ~/.harness-squared/history.jsonl. Survives daemon restarts.
// Read by `h2 history` so Opus can see past delegations.

import type { Job } from "../shared/types.ts";
import { dataDir } from "../shared/paths.ts";
import { join } from "@std/path";
import { log } from "../shared/log.ts";

export type HistoryEntry = {
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

const historyPath = () => join(dataDir(), "history.jsonl");

export async function appendHistory(job: Job, summary?: string) {
  const entry: HistoryEntry = {
    jobId: job.id,
    planId: job.planId,
    sessionId: job.sessionId,
    task: job.task.split("\n")[0].slice(0, 200),
    state: job.state,
    error: job.error,
    summary: summary?.split("\n")[0].slice(0, 200),
    createdAt: job.createdAt,
    finishedAt: new Date().toISOString(),
  };
  try {
    await Deno.writeTextFile(historyPath(), JSON.stringify(entry) + "\n", { append: true });
  } catch (e) {
    log.warn("history: write failed", { err: String(e) });
  }
}

export async function readHistory(limit = 50): Promise<HistoryEntry[]> {
  try {
    const text = await Deno.readTextFile(historyPath());
    const lines = text.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as HistoryEntry)
      .reverse();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}
