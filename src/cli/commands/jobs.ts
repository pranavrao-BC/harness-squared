// Lists all jobs known to the daemon as a formatted table or JSON.
import { ipcGet } from "../ipc.ts";
import type { Job } from "../../shared/types.ts";
import { formatJobsTable } from "../format.ts";

export async function cmdJobs(args: string[]): Promise<number> {
  const jobs = await ipcGet<Job[]>("/jobs");
  if (args.includes("--json")) {
    console.log(JSON.stringify(jobs, null, 2));
  } else {
    console.log(formatJobsTable(jobs));
  }
  return 0;
}
