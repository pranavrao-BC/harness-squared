// Approves or denies a pending permission request for a job.
import { ipcPost } from "../ipc.ts";
import type { PermissionResponse } from "../../shared/types.ts";

export async function cmdApprove(args: string[]): Promise<number> {
  return await respond(args, "once");
}

export async function cmdDeny(args: string[]): Promise<number> {
  return await respond(args, "reject");
}

async function respond(args: string[], response: PermissionResponse): Promise<number> {
  const [id, permId] = args;
  if (!id || !permId) {
    console.error(`usage: h2 ${response === "reject" ? "deny" : "approve"} <job-id> <perm-id>`);
    return 2;
  }
  await ipcPost<{ ok: boolean }>(`/jobs/${id}/permissions/${permId}`, { response });
  console.log(response);
  return 0;
}
