// Daemon entrypoint. Boots:
//   1) Executor adapter(s) via factory
//   2) JobManager + PermissionStore
//   3) HTTP server over unix socket

import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";
import { loadConfig } from "../config.ts";
import { log } from "../shared/log.ts";
import { createAdapters } from "./executor/factory.ts";
import type { ExecutorAdapter } from "./executor/types.ts";
import { OpencodeAdapter } from "./executor/opencode/adapter.ts";
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

  const adapters = await createAdapters(config);

  const permissions = new PermissionStore();
  const jobs = new JobManager(config, adapters, permissions);
  jobs.startDispatchLoop();

  // Write pid file — include opencode process info if available for backward compat.
  const pidInfo: Record<string, unknown> = { daemon: Deno.pid };
  const ocAdapter = adapters.get("opencode");
  if (ocAdapter instanceof OpencodeAdapter && ocAdapter.processInfo) {
    pidInfo.opencode = ocAdapter.processInfo.pid;
    pidInfo.opencodePort = ocAdapter.processInfo.port;
  }
  await Deno.writeTextFile(config.pidPath, JSON.stringify(pidInfo, null, 2));

  let shuttingDown = false;
  let server: Deno.HttpServer | null = null;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("daemon: shutting down", { reason });
    try {
      jobs.stopDispatchLoop();
      const stopPromises: Promise<void>[] = [];
      for (const adapter of adapters.values()) {
        stopPromises.push(adapter.stop());
      }
      await Promise.allSettled(stopPromises);
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

const isDirectRun = import.meta.main &&
  new URL(import.meta.url).pathname.endsWith("daemon/main.ts");
if (isDirectRun) {
  await main();
}
