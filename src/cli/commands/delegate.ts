// Creates a new job by submitting a task description to the daemon and prints the job ID.
import { ipcPost } from "../ipc.ts";

export async function cmdDelegate(args: string[]): Promise<number> {
  const task = args.join(" ").trim();
  if (!task) {
    console.error("usage: h2 delegate <task>");
    return 2;
  }
  const res = await ipcPost<{ id: string; sessionId: string; state: string }>("/jobs", { task });
  console.log(res.id);
  return 0;
}
