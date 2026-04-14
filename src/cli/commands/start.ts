// Starts the harness² daemon as a detached child process, or exits cleanly if already running.
import { ipcGet, IpcError } from "../ipc.ts";
import { loadConfig } from "../../config.ts";
import { logPath, dataDir } from "../../shared/paths.ts";
import { ensureDir } from "@std/fs";

/**
 * `h2 start` — idempotent: if the daemon is already up, exit 0. Otherwise
 * spawn the daemon as a detached child with its stdout/stderr redirected
 * *by the shell* (not through CLI pipes) so the daemon survives CLI exit and
 * its logs are captured.
 */
export async function cmdStart(): Promise<number> {
  const config = await loadConfig();
  await ensureDir(dataDir());

  try {
    const res = await ipcGet<{ ok: boolean; pid: number }>("/health");
    if (res.ok) {
      console.log(`harness² daemon already running (pid ${res.pid})`);
      return 0;
    }
  } catch (e) {
    if (!(e instanceof IpcError)) throw e;
  }

  const entry = resolveDaemonEntry();
  const log = logPath();

  // Stamp log start boundary.
  await Deno.writeTextFile(log, `\n=== daemon starting ${new Date().toISOString()} ===\n`, {
    append: true,
  });

  // Launch via sh so the shell can own the output redirection and the child
  // can fully detach. `setsid` isn't available on macOS; `nohup + &` is fine.
  // Using `exec` replaces the shell with the daemon so the shell doesn't
  // linger as an extra process.
  const shellCmd = [
    `exec ${shellQuote(entry.bin)} ${entry.args.map(shellQuote).join(" ")}`,
    `>> ${shellQuote(log)} 2>&1 < /dev/null &`,
    `echo $!`,
  ].join(" ");

  const cmd = new Deno.Command("sh", {
    args: ["-c", shellCmd],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject() },
  });
  const { code, stdout, stderr } = await cmd.output();
  const pidLine = new TextDecoder().decode(stdout).trim();
  if (code !== 0) {
    console.error(`failed to spawn daemon: ${new TextDecoder().decode(stderr)}`);
    return 1;
  }

  // Wait up to 10s for /health.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await ipcGet<{ ok: boolean; pid: number }>("/health");
      if (res.ok) {
        console.log(`harness² daemon started (pid ${res.pid})`);
        console.log(`  log:    ${log}`);
        console.log(`  socket: ${config.socketPath}`);
        return 0;
      }
    } catch { /* keep polling */ }
    await sleep(100);
  }

  console.error(`daemon failed to start (spawned pid ${pidLine}) — see ${log}`);
  return 1;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=@:+]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveDaemonEntry(): { bin: string; args: string[] } {
  const override = Deno.env.get("H2_DAEMON_CMD");
  if (override) {
    const parts = override.split(" ").filter(Boolean);
    return { bin: parts[0], args: parts.slice(1) };
  }
  // When running as a compiled binary, Deno.execPath() IS the h2 binary.
  // Use the hidden `__daemon` subcommand to re-exec as daemon.
  const execPath = Deno.execPath();
  const isCompiled = !execPath.includes("deno");
  if (isCompiled) {
    return { bin: execPath, args: ["__daemon"] };
  }
  // Running from source — invoke deno run on the daemon entry.
  const here = new URL("../../daemon/main.ts", import.meta.url);
  const path = decodeURIComponent(here.pathname);
  return {
    bin: execPath,
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      path,
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
