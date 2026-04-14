// Subscribes to opencode's /event SSE stream, demultiplexes by sessionID, and
// translates the raw events into h2-internal Events.
//
// Designed to run as one long-lived task. Caller registers listeners per
// sessionID. Reconnects on failure with a small backoff.

import { parseSse } from "../../../shared/sse.ts";
import type { Event, PermissionRequest } from "../../../shared/types.ts";
import type { OcPermissionRequest } from "./client.ts";
import { log } from "../../../shared/log.ts";
import type { ExecutorEventHandler } from "../types.ts";

export type RawOpencodeEvent = { type: string; properties?: Record<string, unknown> };

/** Per-session state the translator needs to filter user-vs-assistant parts. */
type SessionState = {
  assistantMessageIds: Set<string>;
  userMessageIds: Set<string>;
};

type Listener = {
  sessionId: string;
  handler: ExecutorEventHandler;
};

export class OpencodeEventBridge {
  private listeners = new Set<Listener>();
  private running = false;
  private controller: AbortController | null = null;
  private sessionState = new Map<string, SessionState>();

  constructor(private baseUrl: string) {}

  private state(sessionId: string): SessionState {
    let s = this.sessionState.get(sessionId);
    if (!s) {
      s = { assistantMessageIds: new Set(), userMessageIds: new Set() };
      this.sessionState.set(sessionId, s);
    }
    return s;
  }

  subscribe(sessionId: string, handler: ExecutorEventHandler): () => void {
    const l: Listener = { sessionId, handler };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.controller?.abort();
  }

  private async loop() {
    let backoff = 500;
    while (this.running) {
      this.controller = new AbortController();
      try {
        log.info("opencode_events: subscribing", { url: `${this.baseUrl}/event` });
        const res = await fetch(`${this.baseUrl}/event`, { signal: this.controller.signal });
        if (!res.ok || !res.body) {
          log.warn("opencode_events: bad response", { status: res.status });
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 10_000);
          continue;
        }
        backoff = 500;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const chunks = async function* () {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            yield dec.decode(value, { stream: true });
          }
        };
        for await (const frame of parseSse(chunks())) {
          let parsed: RawOpencodeEvent;
          try {
            parsed = JSON.parse(frame.data);
          } catch (e) {
            log.warn("opencode_events: bad JSON", { err: String(e), data: frame.data.slice(0, 200) });
            continue;
          }
          this.dispatch(parsed);
        }
      } catch (e) {
        if (!this.running) return;
        log.warn("opencode_events: stream error", { err: String(e) });
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  private dispatch(raw: RawOpencodeEvent) {
    const sessionId = extractSessionId(raw);
    if (!sessionId) return;

    if (raw.type === "message.updated") {
      const info = (raw.properties as { info?: { id?: string; role?: string } } | undefined)?.info;
      if (info?.id && info.role) {
        const s = this.state(sessionId);
        if (info.role === "assistant") s.assistantMessageIds.add(info.id);
        else if (info.role === "user") s.userMessageIds.add(info.id);
      }
    }

    for (const l of this.listeners) {
      if (l.sessionId !== sessionId) continue;
      const translated = translate(raw, l.sessionId, this.state(sessionId));
      l.handler(translated, raw.type);
    }
  }
}

function extractSessionId(raw: RawOpencodeEvent): string | null {
  const p = raw.properties as Record<string, unknown> | undefined;
  if (!p) return null;
  const direct = typeof p.sessionID === "string" ? p.sessionID : null;
  if (direct) return direct;
  const info = p.info as Record<string, unknown> | undefined;
  if (info && typeof info.sessionID === "string") return info.sessionID;
  return null;
}

/** Translate one raw opencode event into zero or more h2 Events. */
export function translate(
  raw: RawOpencodeEvent,
  jobSessionId: string,
  state?: SessionState,
): Event[] {
  const p = raw.properties as Record<string, unknown> | undefined;
  if (!p) return [];
  switch (raw.type) {
    case "permission.asked": {
      const pr = p as unknown as OcPermissionRequest;
      const request: PermissionRequest = {
        id: pr.id,
        jobId: jobSessionId, // caller will remap to h2 jobId
        permission: pr.permission,
        patterns: pr.patterns ?? [],
        description: describePermission(pr),
        toolCallId: pr.tool?.callID,
        messageId: pr.tool?.messageID,
        metadata: pr.metadata,
        createdAt: new Date().toISOString(),
        resolved: false,
      };
      return [{ type: "permission.request", request }];
    }
    case "permission.replied": {
      const id = typeof p.requestID === "string" ? p.requestID : "";
      const reply = p.reply as string | undefined;
      const response: "once" | "always" | "reject" = reply === "once"
        ? "once"
        : reply === "always"
        ? "always"
        : "reject";
      return [{ type: "permission.resolved", id, response }];
    }
    case "session.idle":
      return [];
    case "session.error": {
      const err = p.error as { name?: string; data?: { message?: string } } | undefined;
      const msg = err?.data?.message ?? err?.name ?? "unknown error";
      return [{ type: "job.error", error: msg }];
    }
    case "session.status":
      return [];
    case "message.part.updated": {
      const part = p.part as Record<string, unknown> | undefined;
      if (!part) return [];
      const msgId = typeof part.messageID === "string" ? part.messageID : "";
      if (state && msgId && state.userMessageIds.has(msgId)) return [];
      return partToEvents(part);
    }
    case "message.updated": {
      return [];
    }
    default:
      return [];
  }
}

function partToEvents(part: Record<string, unknown>): Event[] {
  const t = String(part.type);
  const partId = String(part.id ?? "");
  switch (t) {
    case "text": {
      const text = String(part.text ?? "");
      const synthetic = Boolean(part.synthetic);
      if (synthetic) return [];
      return [{ type: "assistant.delta", text, partId }];
    }
    case "tool": {
      const state = part.state as Record<string, unknown> | undefined;
      const tool = String(part.tool ?? "");
      const callId = String(part.callID ?? "");
      const stateType = state && typeof state === "object" && "status" in state
        ? String((state as { status: unknown }).status)
        : undefined;
      if (stateType === "completed") {
        const output = state && "output" in state ? (state as { output: unknown }).output : undefined;
        return [{ type: "tool.result", name: tool, callId, output }];
      }
      if (stateType === "error") {
        const err = state && "error" in state ? String((state as { error: unknown }).error) : "error";
        return [{ type: "tool.result", name: tool, callId, output: null, error: err }];
      }
      return [{
        type: "tool.use",
        name: tool,
        callId,
        input: state && "input" in state ? (state as { input: unknown }).input : undefined,
        state: stateType,
      }];
    }
    default:
      return [];
  }
}

function describePermission(pr: OcPermissionRequest): string {
  const pat = (pr.patterns ?? []).join(", ");
  const tool = pr.tool?.callID ? ` [${pr.tool.callID.slice(0, 8)}]` : "";
  if (pat) return `${pr.permission}: ${pat}${tool}`;
  const meta = pr.metadata ? summariseMetadata(pr.metadata) : "";
  if (meta) return `${pr.permission}: ${meta}${tool}`;
  return `${pr.permission}${tool}`;
}

function summariseMetadata(m: Record<string, unknown>): string {
  for (const k of ["command", "filepath", "path", "url", "target"]) {
    const v = m[k];
    if (typeof v === "string" && v) return `${k}=${v.length > 80 ? v.slice(0, 77) + "..." : v}`;
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
