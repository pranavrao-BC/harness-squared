// Daemon entrypoint. Boots:
//   1) opencode serve child (owns port)
//   2) opencode event bridge (SSE subscriber)
//   3) JobManager + PermissionStore
//   4) HTTP server over unix socket

import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";
import { loadConfig } from "../config.ts";
import { log } from "../shared/log.ts";
import { startOpencode } from "./opencode_process.ts";
import { OpencodeClient } from "./opencode_client.ts";
import { OpencodeEventBridge } from "./opencode_events.ts";
import { PermissionStore } from "./permissions.ts";
import { JobManager } from "./jobs.ts";
import { buildHandler } from "./server.ts";

export async function main() {
  const config = await loadConfig();
  log.info("daemon: starting", { socket: config.socketPath, pid: Deno.pid });

  try {
    await Deno.remove(config.socketPath);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      log.warn("daemon: could not remove old socket", { err: String(e) });
    }
  }
  await ensureDir(dirname(config.socketPath));

  const oc = await startOpencode(config);
  const client = new OpencodeClient(oc.baseUrl, config);
  await client.health().catch((e) => {
    log.warn("daemon: opencode health check failed", { err: String(e) });
  });

  const bridge = new OpencodeEventBridge(oc.baseUrl);
  bridge.start();

  const permissions = new PermissionStore();
  const jobs = new JobManager(config, client, bridge, permissions);
  jobs.startDispatchLoop();

  await Deno.writeTextFile(
    config.pidPath,
    JSON.stringify({ daemon: Deno.pid, opencode: oc.pid, opencodePort: oc.port }, null, 2),
  );

  let shuttingDown = false;
  let server: Deno.HttpServer | null = null;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("daemon: shutting down", { reason });
    try {
      jobs.stopDispatchLoop();
      bridge.stop();
      await oc.stop();
      await server?.shutdown();
      try {
        await Deno.remove(config.socketPath);
      } catch { /* ignore */ }
      try {
        await Deno.remove(config.pidPath);
      } catch { /* ignore */ }
    } catch (e) {
      log.warn("daemon: shutdown error", { err: String(e) });
    } finally {
      Deno.exit(0);
    }
  };

  const handler = buildHandler(config, jobs, () => {
    shutdown("http /shutdown");
  });

  server = Deno.serve(
    {
      path: config.socketPath,
      onListen: (l) => log.info("daemon: listening", l),
    },
    handler,
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => shutdown(sig));
    } catch { /* not all platforms */ }
  }

  await server.finished;
}

if (import.meta.main) {
  await main();
}
