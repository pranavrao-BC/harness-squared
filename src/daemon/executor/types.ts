// Executor adapter interface — the abstraction boundary between jobs.ts and
// any backend harness (opencode, gemini-cli, etc). Every adapter translates
// its backend's protocol into these types so the job lifecycle stays
// backend-agnostic.

import type { Event, PermissionResponse } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Normalized message types (backend-agnostic conversation history)
// ---------------------------------------------------------------------------

export type NormalizedPart =
  | { readonly type: "text"; readonly text: string; readonly synthetic?: boolean }
  | {
      readonly type: "tool";
      readonly tool: string;
      readonly callId: string;
      readonly status?: string;
      readonly input?: unknown;
      readonly output?: unknown;
      readonly error?: string;
    }
  | { readonly type: "reasoning"; readonly text: string };

export type NormalizedMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly NormalizedPart[];
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly error?: string;
};

// ---------------------------------------------------------------------------
// Executor event handler
// ---------------------------------------------------------------------------

/** Handler for translated executor events. rawType is the backend-specific event name. */
export type ExecutorEventHandler = (events: Event[], rawType: string) => void;

// ---------------------------------------------------------------------------
// Executor configuration (per-executor section from config.toml)
// ---------------------------------------------------------------------------

export type ExecutorConfig = {
  readonly type: "opencode" | "gemini";
  readonly bin: string;
  readonly args: readonly string[];
  readonly model?: string;
  readonly agent?: string;
};

// ---------------------------------------------------------------------------
// Prompt options — passed per-call through the adapter boundary
// ---------------------------------------------------------------------------

export type PromptOptions = {
  /** Working directory for the executor process. Defaults to daemon cwd. */
  readonly cwd?: string;
  /** Override the model for this prompt. Falls back to executor config default. */
  readonly model?: string;
};

// ---------------------------------------------------------------------------
// ExecutorAdapter — the interface every backend must implement
// ---------------------------------------------------------------------------

export interface ExecutorAdapter {
  /** Display name for logging / UI ("opencode", "gemini-cli"). */
  readonly name: string;

  /** Raw event type names that signal "session finished / idle". */
  readonly idleSignals: readonly string[];

  /** Raw event type names that signal "session is active / busy". */
  readonly activeSignals: readonly string[];

  /** Start the backend process / connection. */
  start(): Promise<void>;

  /** Graceful shutdown. */
  stop(): Promise<void>;

  /** Create a new session for a task. Returns an opaque session ID. */
  createSession(title: string): Promise<string>;

  /** Fire-and-forget prompt into an existing session. */
  prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<void>;

  /** Respond to a permission / tool-approval request. */
  respondPermission(
    sessionId: string,
    permId: string,
    response: PermissionResponse,
  ): Promise<void>;

  /** Abort / cancel a running session. */
  abort(sessionId: string): Promise<void>;

  /** Fetch conversation history for a session as normalised messages. */
  listMessages(sessionId: string): Promise<NormalizedMessage[]>;

  /** Subscribe to translated events for a specific session. Returns unsubscribe fn. */
  subscribe(sessionId: string, handler: ExecutorEventHandler): () => void;
}
