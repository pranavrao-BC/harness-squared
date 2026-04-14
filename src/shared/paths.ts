import { join } from "@std/path";

export function homeDir(): string {
  const h = Deno.env.get("HOME");
  if (!h) throw new Error("HOME not set");
  return h;
}

export function dataDir(): string {
  return join(homeDir(), ".harness-squared");
}

export function socketPath(): string {
  return Deno.env.get("H2_SOCKET") ?? join(dataDir(), "daemon.sock");
}

export function logPath(): string {
  return join(dataDir(), "daemon.log");
}

export function pidPath(): string {
  return join(dataDir(), "pids.json");
}

export function configPath(): string {
  return Deno.env.get("H2_CONFIG") ?? join(homeDir(), ".config", "harness-squared", "config.toml");
}
