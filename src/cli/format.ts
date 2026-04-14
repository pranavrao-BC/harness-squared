import type { Job } from "../shared/types.ts";

export function formatJobsTable(jobs: Job[]): string {
  if (jobs.length === 0) return "(no jobs)";
  const rows = jobs.map((j) => [
    j.id,
    j.state.padEnd(7),
    truncate(j.task.split("\n")[0], 60),
    j.createdAt.replace("T", " ").slice(0, 19),
  ]);
  const widths = [10, 7, 60, 19];
  const header = ["id", "state", "task", "created"];
  const out: string[] = [];
  out.push(header.map((h, i) => h.padEnd(widths[i])).join("  "));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) out.push(r.map((c, i) => c.padEnd(widths[i])).join("  "));
  return out.join("\n");
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export const color = Deno.stdout.isTerminal() ? COLORS : Object.fromEntries(
  Object.keys(COLORS).map((k) => [k, ""]),
) as typeof COLORS;
