// Shuts down the running harness² daemon via the shutdown IPC endpoint.
import { ipcPost, IpcError } from "../ipc.ts";

export async function cmdStop(): Promise<number> {
  try {
    await ipcPost<{ ok: boolean }>("/shutdown");
    console.log("harness² daemon stopped");
    return 0;
  } catch (e) {
    if (e instanceof IpcError && e.status === 503) {
      console.log("daemon not running");
      return 0;
    }
    throw e;
  }
}
