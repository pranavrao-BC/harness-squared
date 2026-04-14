// Typed thin wrappers around opencode's HTTP API. Endpoints verified against
// a live opencode 1.4.3 server.

import type { ExecutorConfig } from "../types.ts";

export type OcSession = {
  readonly id: string;
  readonly slug: string;
  readonly version: string;
  readonly projectID: string;
  readonly directory: string;
  readonly title: string;
  readonly time: { readonly created: number; readonly updated: number };
};

export type OcPermissionRequest = {
  readonly id: string;
  readonly sessionID: string;
  readonly permission: string;
  readonly patterns: string[];
  readonly metadata: Record<string, unknown>;
  readonly always: string[];
  readonly tool?: { readonly messageID: string; readonly callID: string };
};

export type OcMessageRow = {
  readonly info: {
    readonly id: string;
    readonly sessionID: string;
    readonly role: "user" | "assistant";
    readonly time: { readonly created: number; readonly completed?: number };
    readonly error?: { readonly name: string; readonly data: { readonly message?: string } };
  };
  readonly parts: ReadonlyArray<
    | { readonly type: "text"; readonly text: string; readonly synthetic?: boolean }
    | { readonly type: "reasoning"; readonly text: string }
    | { readonly type: "tool"; readonly tool: string; readonly callID: string; readonly state: unknown }
    | { readonly type: "file"; readonly filename?: string; readonly url: string }
    | {
        readonly type:
          | "step-start"
          | "step-finish"
          | "patch"
          | "snapshot"
          | "subtask"
          | "agent"
          | "retry"
          | "compaction";
        readonly [k: string]: unknown;
      }
  >;
};

export class OpencodeClient {
  constructor(
    private baseUrl: string,
    private executorConfig: ExecutorConfig,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return {} as T;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return {} as T;
    }
    return (await res.json()) as T;
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
    if (this.executorConfig.model) {
      const parsed = parseModel(this.executorConfig.model);
      if (parsed) body.model = parsed;
    }
    if (this.executorConfig.agent) body.agent = this.executorConfig.agent;
    await this.req("POST", `/session/${sessionId}/prompt_async`, body);
  }

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

  listMessages(sessionId: string): Promise<OcMessageRow[]> {
    return this.req<OcMessageRow[]>("GET", `/session/${sessionId}/message`);
  }
}

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
