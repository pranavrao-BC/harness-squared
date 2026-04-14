// Fetches and prints the final assistant output of a completed job.
import { ipcGet, IpcError } from "../ipc.ts";
import type { Job } from "../../shared/types.ts";

export async function cmdOutput(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: h2 output <job-id> [--full]");
    return 2;
  }
  const full = args.includes("--full");
  const job = await ipcGet<Job>(`/jobs/${id}`);
  if (job.state === "pending" || job.state === "running") {
    console.error(`job state=${job.state}, not finished yet`);
    return 2;
  }
  try {
    const suffix = full ? "?full=1" : "";
    const res = await ipcGet<{ text: string }>(`/jobs/${id}/output${suffix}`);
    console.log(res.text);
    return job.state === "error" ? 1 : 0;
  } catch (e) {
    if (e instanceof IpcError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
