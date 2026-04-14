// Typed thin wrappers around opencode's HTTP API. Endpoints verified against
// a live opencode 1.4.3 server (see DESIGN.md §13 Q1 — event shapes confirmed).
//
// Note: opencode's /doc OpenAPI only declares /global/* paths, but the session
// endpoints below work and are documented at https://opencode.ai/docs/server/.

import type { Config } from "../shared/types.ts";

export type OcSession = {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
};

export type OcPermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};

export class OpencodeClient {
  constructor(
    private baseUrl: string,
    private config: Config,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`opencode ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return {} as T;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return {} as T;
    }
    return await res.json() as T;
  }

  health(): Promise<unknown> {
    return this.req("GET", "/global/health");
  }

  createSession(title: string): Promise<OcSession> {
    return this.req<OcSession>("POST", "/session", { title });
  }

  /** Fire-and-forget: returns 204 immediately. Events come on /event. */
  async promptAsync(sessionId: string, text: string): Promise<void> {
    const body: {
      parts: Array<{ type: "text"; text: string }>;
      model?: { providerID: string; modelID: string };
      agent?: string;
    } = {
      parts: [{ type: "text", text }],
    };
    if (this.config.model) {
      const parsed = parseModel(this.config.model);
      if (parsed) body.model = parsed;
    }
    if (this.config.agent) body.agent = this.config.agent;
    await this.req("POST", `/session/${sessionId}/prompt_async`, body);
  }

  /** Opencode's permission endpoint expects {response: "once"|"always"|"reject"}. */
  respondPermission(
    sessionId: string,
    permId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    return this.req("POST", `/session/${sessionId}/permissions/${permId}`, { response });
  }

  abortSession(sessionId: string): Promise<void> {
    return this.req("POST", `/session/${sessionId}/abort`, {});
  }

  /** Fetch full message list for a session. Used to render final assistant text. */
  listMessages(sessionId: string): Promise<OcMessageRow[]> {
    return this.req<OcMessageRow[]>("GET", `/session/${sessionId}/message`);
  }
}

export type OcMessageRow = {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    error?: { name: string; data: { message?: string } };
  };
  parts: Array<
    | { type: "text"; text: string; synthetic?: boolean }
    | { type: "reasoning"; text: string }
    | { type: "tool"; tool: string; callID: string; state: unknown }
    | { type: "file"; filename?: string; url: string }
    | { type: "step-start" | "step-finish" | "patch" | "snapshot" | "subtask" | "agent" | "retry" | "compaction"; [k: string]: unknown }
  >;
};

/** Parse "provider/model" or "provider/model@variant" into opencode's per-request model object. */
function parseModel(s: string): { providerID: string; modelID: string; variant?: string } | null {
  const slash = s.indexOf("/");
  if (slash < 0) return null;
  const providerID = s.slice(0, slash);
  let rest = s.slice(slash + 1);
  let variant: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    variant = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  return { providerID, modelID: rest, ...(variant ? { variant } : {}) };
}
