// Spawns and owns the `opencode serve` child. Parses the bind line from its
// stdout to learn the port it picked.

import { log } from "../shared/log.ts";
import type { Config } from "../shared/types.ts";

export type OpencodeProcess = {
  pid: number;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
};

export async function startOpencode(config: Config): Promise<OpencodeProcess> {
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0", ...config.opencodeArgs];
  log.info("opencode_process: spawning", { bin: config.opencodeBin, args });
  const cmd = new Deno.Command(config.opencodeBin, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject() },
  });
  const child = cmd.spawn();

  // Drain stderr to daemon log (never block it).
  consumeTo("opencode.stderr", child.stderr);

  const port = await waitForPort(child.stdout);
  log.info("opencode_process: listening", { pid: child.pid, port });

  // Continue streaming stdout into the log in the background.
  consumeTo("opencode.stdout", child.stdout, /*alreadyPartial*/ true);

  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already dead */ }
    try {
      const { code } = await withTimeout(child.status, 3000);
      log.info("opencode_process: exited", { code });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
    }
  };

  return {
    pid: child.pid,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop,
  };
}

/** Reads the child's stdout until we see a "opencode server listening on http://host:port" line. */
async function waitForPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  // We need to peek at stdout without closing it — use a teeing reader.
  const reader = stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) throw new Error("opencode exited before binding a port");
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
    if (m) {
      reader.releaseLock();
      // Log anything we have so far.
      log.debug("opencode.stdout", { early: buf.slice(0, 400) });
      // Put remaining bytes + future stream back into the logger in consumeTo.
      return Number(m[1]);
    }
  }
  reader.releaseLock();
  throw new Error("timed out waiting for opencode to print its bind address");
}

async function consumeTo(label: string, stream: ReadableStream<Uint8Array>, alreadyPartial = false) {
  try {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) log.debug(label, { line });
      }
    }
    if (buf.trim()) log.debug(label, { line: buf });
    if (alreadyPartial) log.debug(label, { note: "eof" });
  } catch (e) {
    log.warn(`${label}: read error`, { err: String(e) });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
