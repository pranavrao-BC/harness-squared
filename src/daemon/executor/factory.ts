// Executor factory — reads config and instantiates the correct adapter(s).

import type { Config } from "../../shared/types.ts";
import type { ExecutorAdapter, ExecutorConfig } from "./types.ts";
import { OpencodeAdapter } from "./opencode/adapter.ts";
import { GeminiAdapter } from "./gemini/adapter.ts";
import { log } from "../../shared/log.ts";

/** Create all configured executor adapters. Starts each one. */
export async function createAdapters(
  config: Config,
): Promise<Map<string, ExecutorAdapter>> {
  const adapters = new Map<string, ExecutorAdapter>();

  for (const [name, ec] of Object.entries(config.executors)) {
    const executorConfig: ExecutorConfig = {
      type: ec.type,
      bin: ec.bin,
      args: ec.args,
      model: ec.model,
      agent: ec.agent,
      yolo: ec.yolo,
    };

    const adapter = buildAdapter(name, executorConfig);
    log.info("factory: starting executor", { name, type: ec.type });
    await adapter.start();
    adapters.set(name, adapter);
  }

  if (!adapters.has(config.defaultExecutor)) {
    throw new Error(
      `default executor "${config.defaultExecutor}" not found in configured executors: [${[...adapters.keys()].join(", ")}]`,
    );
  }

  return adapters;
}

function buildAdapter(name: string, config: ExecutorConfig): ExecutorAdapter {
  switch (config.type) {
    case "opencode":
      return new OpencodeAdapter(config);
    case "gemini":
      return new GeminiAdapter(config);
    default:
      throw new Error(`unknown executor type "${config.type}" for "${name}"`);
  }
}
