// Shows kanban-style view of all jobs, grouped by state.
import { ipcGet } from "../ipc.ts";
import type { Job } from "../../shared/types.ts";
import { color } from "../format.ts";

const COLS: Array<{ state: string; label: string; c: string }> = [
  { state: "pending", label: "PENDING", c: color.dim },
  { state: "running", label: "RUNNING", c: color.cyan },
  { state: "done", label: "DONE", c: color.green },
  { state: "error", label: "ERROR", c: color.red },
  { state: "stopped", label: "STOPPED", c: color.yellow },
];

export async function cmdBoard(_args: string[]): Promise<number> {
  const jobs = await ipcGet<Job[]>("/jobs");
  if (jobs.length === 0) {
    console.log("(no jobs)");
    return 0;
  }
  const grouped = new Map<string, Job[]>();
  for (const j of jobs) {
    const arr = grouped.get(j.state) ?? [];
    arr.push(j);
    grouped.set(j.state, arr);
  }
  for (const col of COLS) {
    const items = grouped.get(col.state) ?? [];
    if (items.length === 0) continue;
    console.log(`${col.c}${col.label}${color.reset} (${items.length})`);
    for (const j of items) {
      const deps = j.deps?.length ? ` ${color.dim}← [${j.deps.map((d) => d.slice(-6)).join(",")}]${color.reset}` : "";
      const task = j.task.split("\n")[0].slice(0, 70);
      console.log(`  ${j.id.slice(-8)}  ${task}${deps}`);
    }
  }
  return 0;
}
