// Sends a user message into a running job's conversation.
import { ipcPost } from "../ipc.ts";

export async function cmdSend(args: string[]): Promise<number> {
  const [id, ...rest] = args;
  const content = rest.join(" ").trim();
  if (!id || !content) {
    console.error("usage: h2 send <job-id> <message>");
    return 2;
  }
  await ipcPost<{ ok: boolean }>(`/jobs/${id}/messages`, { content });
  console.log("sent");
  return 0;
}
