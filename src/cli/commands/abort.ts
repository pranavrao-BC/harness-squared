// Stops a running job by posting an abort request to the daemon.
import { ipcPost } from "../ipc.ts";

export async function cmdAbort(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: h2 abort <job-id>");
    return 2;
  }
  await ipcPost<{ ok: boolean }>(`/jobs/${id}/stop`);
  console.log("aborted");
  return 0;
}
