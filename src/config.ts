import { parse as parseToml } from "@std/toml";
import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";
import type { Config } from "./shared/types.ts";
import { configPath, dataDir, logPath, pidPath, socketPath } from "./shared/paths.ts";

type ExecutorToml = {
  bin?: string;
  args?: string[];
  model?: string;
  agent?: string;
};

type TomlShape = {
  executor?: string; // default executor name
  daemon?: { socket?: string };
  // Legacy: [opencode] section still works
  opencode?: ExecutorToml;
  // New: [gemini] section
  gemini?: ExecutorToml;
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

  // Build executor map from known sections
  const executors: Config["executors"] = {};

  if (parsed.opencode || !parsed.executor || parsed.executor === "opencode") {
    const oc = parsed.opencode ?? {};
    executors.opencode = {
      type: "opencode",
      bin: oc.bin ?? "opencode",
      args: oc.args ?? [],
      model: oc.model,
      agent: oc.agent,
    };
  }

  if (parsed.gemini) {
    const gc = parsed.gemini;
    executors.gemini = {
      type: "gemini",
      bin: gc.bin ?? "gemini",
      args: gc.args ?? [],
      model: gc.model,
      agent: gc.agent,
    };
  }

  return {
    socketPath: parsed.daemon?.socket ?? socketPath(),
    defaultExecutor: parsed.executor ?? "opencode",
    executors,
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
