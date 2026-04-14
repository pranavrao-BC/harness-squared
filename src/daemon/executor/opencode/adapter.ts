// OpencodeAdapter — wraps the opencode HTTP API, SSE event bridge, and child
// process into the ExecutorAdapter interface so jobs.ts stays backend-agnostic.

import type {
  ExecutorAdapter,
  ExecutorConfig,
  ExecutorEventHandler,
  NormalizedMessage,
  NormalizedPart,
  PromptOptions,
} from "../types.ts";
import type { PermissionResponse } from "../../../shared/types.ts";
import { log } from "../../../shared/log.ts";
import { OpencodeClient, type OcMessageRow } from "./client.ts";
import { OpencodeEventBridge } from "./events.ts";
import { startOpencode, type OpencodeProcess } from "./process.ts";

export class OpencodeAdapter implements ExecutorAdapter {
  readonly name = "opencode";
  readonly idleSignals: readonly string[] = ["session.idle"];
  readonly activeSignals: readonly string[] = ["session.status"];

  private process: OpencodeProcess | null = null;
  private client: OpencodeClient | null = null;
  private bridge: OpencodeEventBridge | null = null;

  constructor(private readonly config: ExecutorConfig) {}

  async start(): Promise<void> {
    this.process = await startOpencode(this.config);
    this.client = new OpencodeClient(this.process.baseUrl, this.config);
    await this.client.health().catch((e) => {
      log.warn("opencode: health check failed", { err: String(e) });
    });
    this.bridge = new OpencodeEventBridge(this.process.baseUrl);
    this.bridge.start();
    log.info("opencode: adapter started", { pid: this.process.pid, port: this.process.port });
  }

  async stop(): Promise<void> {
    this.bridge?.stop();
    await this.process?.stop();
    log.info("opencode: adapter stopped");
  }

  async createSession(title: string): Promise<string> {
    const session = await this.requireClient().createSession(title);
    return session.id;
  }

  async prompt(sessionId: string, text: string, _opts?: PromptOptions): Promise<void> {
    await this.requireClient().promptAsync(sessionId, text);
  }

  async respondPermission(
    sessionId: string,
    permId: string,
    response: PermissionResponse,
  ): Promise<void> {
    await this.requireClient().respondPermission(sessionId, permId, response);
  }

  async abort(sessionId: string): Promise<void> {
    await this.requireClient().abortSession(sessionId);
  }

  async listMessages(sessionId: string): Promise<NormalizedMessage[]> {
    const rows = await this.requireClient().listMessages(sessionId);
    return rows.map(normalizeOcMessage);
  }

  subscribe(sessionId: string, handler: ExecutorEventHandler): () => void {
    return this.requireBridge().subscribe(sessionId, handler);
  }

  /** Expose process info for pid file. */
  get processInfo(): { pid: number; port: number } | null {
    return this.process ? { pid: this.process.pid, port: this.process.port } : null;
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("opencode adapter not started");
    return this.client;
  }

  private requireBridge(): OpencodeEventBridge {
    if (!this.bridge) throw new Error("opencode adapter not started");
    return this.bridge;
  }
}

// ---------------------------------------------------------------------------
// OcMessageRow -> NormalizedMessage conversion
// ---------------------------------------------------------------------------

function normalizeOcMessage(msg: OcMessageRow): NormalizedMessage {
  const parts: NormalizedPart[] = [];
  for (const p of msg.parts) {
    switch (p.type) {
      case "text":
        parts.push({ type: "text", text: p.text, synthetic: p.synthetic });
        break;
      case "reasoning":
        parts.push({ type: "reasoning", text: p.text });
        break;
      case "tool": {
        const st = p.state as Record<string, unknown> | undefined;
        const status = st && typeof st === "object" && "status" in st
          ? String((st as { status: unknown }).status)
          : undefined;
        const input = st && "input" in st ? (st as { input: unknown }).input : undefined;
        const output = st && "output" in st ? (st as { output: unknown }).output : undefined;
        const error = st && "error" in st ? String((st as { error: unknown }).error) : undefined;
        parts.push({
          type: "tool",
          tool: p.tool,
          callId: p.callID,
          status,
          input,
          output,
          error,
        });
        break;
      }
      // file, step-start, step-finish, etc. are opencode-specific — skip.
      default:
        break;
    }
  }
  return {
    id: msg.info.id,
    role: msg.info.role,
    parts,
    createdAt: msg.info.time.created,
    completedAt: msg.info.time.completed,
    error: msg.info.error ? `${msg.info.error.name}: ${msg.info.error.data?.message ?? ""}` : undefined,
  };
}
