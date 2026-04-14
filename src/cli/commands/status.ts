// Displays the current state and pending permission requests for a job.
import { ipcGet } from "../ipc.ts";
import type { Job, PermissionRequest } from "../../shared/types.ts";
import { color } from "../format.ts";

export async function cmdStatus(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: h2 status <job-id>");
    return 2;
  }
  const job = await ipcGet<Job>(`/jobs/${id}`);
  const pending = await ipcGet<PermissionRequest[]>(`/jobs/${id}/permissions`);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ job, pending }, null, 2));
    return 0;
  }
  console.log(`${job.id}  ${job.state}`);
  console.log(`  session:  ${job.sessionId}`);
  console.log(`  created:  ${job.createdAt}`);
  console.log(`  updated:  ${job.updatedAt}`);
  console.log(`  task:     ${job.task.split("\n")[0]}`);
  if (job.error) console.log(`  error:    ${job.error}`);
  if (pending.length) {
    console.log(`  pending permissions:`);
    for (const p of pending) console.log(`    - ${p.id}  ${p.description}`);
  }
  if (job.state === "error" || job.state === "stopped") {
    console.log(
      `\n  ${color.dim}resume: h2 send ${job.id} "continue" (or any guidance)${color.reset}`,
    );
    console.log(
      `  ${color.dim}review: h2 output ${job.id} (see what happened)${color.reset}`,
    );
  }
  return job.state === "error" ? 1 : 0;
}
