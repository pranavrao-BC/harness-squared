import { parse as parseToml } from "@std/toml";
import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";
import type { Config } from "./shared/types.ts";
import { configPath, dataDir, logPath, pidPath, socketPath } from "./shared/paths.ts";

type ExecutorToml = {
  type?: "opencode" | "gemini";
  bin?: string;
  args?: string[];
  model?: string;
  agent?: string;
};

type TomlShape = {
  executor?: string;
  daemon?: { socket?: string };
  executors?: Record<string, ExecutorToml>;
  opencode?: ExecutorToml;
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

  const executors: Config["executors"] = {};

  if (parsed.executors && Object.keys(parsed.executors).length > 0) {
    for (const [name, ec] of Object.entries(parsed.executors)) {
      const type = ec.type ?? (name.includes("gemini") ? "gemini" : "opencode");
      executors[name] = {
        type,
        bin: ec.bin ?? (type === "gemini" ? "gemini" : "opencode"),
        args: ec.args ?? [],
        model: ec.model,
        agent: ec.agent,
      };
    }
  } else {
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
