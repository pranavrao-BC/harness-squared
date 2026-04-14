import { parse as parseToml } from "@std/toml";
import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";
import type { Config } from "./shared/types.ts";
import { configPath, dataDir, logPath, pidPath, socketPath } from "./shared/paths.ts";

type TomlShape = {
  daemon?: { socket?: string };
  opencode?: { bin?: string; args?: string[]; model?: string; agent?: string };
  permissions?: { default?: "wait" | "deny" | "allow"; timeout?: number };
};

export async function loadConfig(): Promise<Config> {
  const path = configPath();
  let parsed: TomlShape = {};
  try {
    const raw = await Deno.readTextFile(path);
    parsed = parseToml(raw) as TomlShape;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  const dir = dataDir();
  await ensureDir(dir);

  return {
    socketPath: parsed.daemon?.socket ?? socketPath(),
    opencodeBin: parsed.opencode?.bin ?? "opencode",
    opencodeArgs: parsed.opencode?.args ?? [],
    model: parsed.opencode?.model,
    agent: parsed.opencode?.agent,
    permissionsDefault: parsed.permissions?.default ?? "wait",
    permissionsTimeout: parsed.permissions?.timeout ?? 0,
    dataDir: dir,
    logPath: logPath(),
    pidPath: pidPath(),
  };
}

export async function ensureConfigDir() {
  await ensureDir(dirname(configPath()));
}
