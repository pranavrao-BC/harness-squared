// Creates a new job by submitting a task description to the daemon and prints the job ID.
import { ipcPost } from "../ipc.ts";

export async function cmdDelegate(args: string[]): Promise<number> {
  let executor: string | undefined;
  let model: string | undefined;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--executor") {
      executor = args[++i];
    } else if (args[i] === "--model") {
      model = args[++i];
    } else {
      taskParts.push(args[i]);
    }
  }

  const task = taskParts.join(" ").trim();
  if (!task) {
    console.error("usage: h2 delegate [--executor <name>] [--model <name>] <task>");
    return 2;
  }

  const res = await ipcPost<{ id: string; sessionId: string; state: string }>("/jobs", {
    task,
    executor,
    model,
    cwd: Deno.cwd(),
  });
  console.log(res.id);
  return 0;
}
