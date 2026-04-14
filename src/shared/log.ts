// Minimal leveled logger for the daemon. Writes to stderr; main.ts may
// redirect stderr to daemon.log when detached.

type Level = "debug" | "info" | "warn" | "error";

const levelOrder: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (Deno.env.get("H2_LOG_LEVEL") ?? "info").toLowerCase() as Level;
const threshold = levelOrder[envLevel] ?? levelOrder.info;

function emit(level: Level, msg: string, extra?: unknown) {
  if (levelOrder[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = extra === undefined
    ? `${ts} ${level.toUpperCase()} ${msg}`
    : `${ts} ${level.toUpperCase()} ${msg} ${safeJson(extra)}`;
  console.error(line);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
