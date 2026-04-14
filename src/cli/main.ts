// `h2` CLI entrypoint. Thin dispatcher.

import { cmdStart } from "./commands/start.ts";
import { cmdStop } from "./commands/stop.ts";
import { cmdDelegate } from "./commands/delegate.ts";
import { cmdJobs } from "./commands/jobs.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdOutput } from "./commands/output.ts";
import { cmdSend } from "./commands/send.ts";
import { cmdApprove, cmdDeny } from "./commands/approve.ts";
import { cmdAbort } from "./commands/abort.ts";
import { cmdTail } from "./commands/tail.ts";
import { cmdWait } from "./commands/wait.ts";
import { cmdPlan } from "./commands/plan.ts";
import { cmdBoard } from "./commands/board.ts";
import { cmdHistory } from "./commands/history.ts";
import { cmdExec } from "./commands/exec.ts";
import { IpcError } from "./ipc.ts";
import { main as daemonMain } from "../daemon/main.ts";

const USAGE = `harness² (h2) — dispatch tasks to executor backends (opencode, gemini-cli, ...).

Usage: h2 <command> [...]

Daemon:
  start                      start the daemon and executor backends (idempotent)
  stop                       stop the daemon

Orchestration:
  exec <script>              run JS with the h2 API (or pipe via stdin)
  delegate <task>            create a single job; prints its id
  plan <json>                create a plan: multiple tasks with deps (or pipe JSON)
  board                      kanban view of all jobs
  history [N]                past jobs (survives daemon restarts)
  jobs                       list jobs
  status <id>                show job state + pending permissions
  output <id>                session log (only after done/error/stopped)
  wait <id>                  block until job finishes, then print result
  send <id> <message>        inject a user message into a live session
  abort <id>                 stop a job

Permissions (use h2 tail for interactive prompts):
  approve <id> <perm-id>     allow a pending permission (once)
  deny    <id> <perm-id>     reject a pending permission

Tailing:
  tail <id>                  subscribe to the job's event stream; prompts for
                             permissions interactively when stdin is a TTY

Env:
  H2_SOCKET                  override the daemon socket path
  H2_CONFIG                  override the config.toml path
  H2_LOG_LEVEL               debug|info|warn|error (daemon-side)
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log("h2 v0.1.0");
    return 0;
  }
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case "__daemon":
      try {
        await daemonMain();
      } catch (e) {
        console.error(`daemon error: ${e}`);
        if ((e as Error).stack) console.error((e as Error).stack);
        return 1;
      }
      return 0;
    case "start":
      return await cmdStart();
    case "stop":
      return await cmdStop();
    case "exec":
      return await cmdExec(rest);
    case "delegate":
      return await cmdDelegate(rest);
    case "plan":
      return await cmdPlan(rest);
    case "board":
      return await cmdBoard(rest);
    case "history":
      return await cmdHistory(rest);
    case "jobs":
      return await cmdJobs(rest);
    case "status":
      return await cmdStatus(rest);
    case "output":
      return await cmdOutput(rest);
    case "send":
      return await cmdSend(rest);
    case "approve":
      return await cmdApprove(rest);
    case "deny":
      return await cmdDeny(rest);
    case "abort":
      return await cmdAbort(rest);
    case "wait":
      return await cmdWait(rest);
    case "tail":
      return await cmdTail(rest);
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(USAGE);
      return 2;
  }
}

try {
  const code = await main(Deno.args);
  Deno.exit(code);
} catch (e) {
  if (e instanceof IpcError) {
    console.error(`error: ${e.message}`);
    Deno.exit(1);
  }
  console.error(`fatal: ${String(e)}`);
  if ((e as Error).stack) console.error((e as Error).stack);
  Deno.exit(1);
}
