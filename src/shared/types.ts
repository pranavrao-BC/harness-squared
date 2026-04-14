// Shared types between daemon and CLI. See DESIGN.md §5.
// Event wire-format (as emitted by the daemon on /jobs/:id/events) is the
// set of h2-internal Event types, NOT raw opencode events.

export type JobState = "pending" | "running" | "done" | "error" | "stopped";

export type Job = {
  id: string; // "job_" + 12 hex chars
  task: string; // verbatim task text
  sessionId: string; // opencode session id (ses_*)
  state: JobState;
  createdAt: string; // ISO 8601
  updatedAt: string;
  finalOutput?: string; // populated on state=done
  error?: string; // populated on state=error
};

// PermissionRequest is normalised. Fields map to opencode's PermissionRequest
// (id, sessionID, permission, patterns, metadata, tool.callID, tool.messageID)
// but we also compute a human description for UI.
export type PermissionRequest = {
  id: string; // opencode's per_* id
  jobId: string;
  permission: string; // e.g. "edit", "bash", "webfetch"
  patterns: string[]; // e.g. ["src/foo.ts"]
  description: string; // prebuilt human string
  toolCallId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  resolved: boolean;
  response?: PermissionResponse;
};

export type PermissionResponse = "once" | "always" | "reject";

// Events emitted on the h2 SSE stream.
export type Event =
  | { type: "status"; state: JobState }
  | { type: "assistant.delta"; text: string; partId: string }
  | { type: "tool.use"; name: string; callId: string; input: unknown; state?: string }
  | { type: "tool.result"; name: string; callId: string; output: unknown; error?: string }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "permission.resolved"; id: string; response: PermissionResponse }
  | { type: "job.done"; summary?: string }
  | { type: "job.error"; error: string }
  | { type: "log"; text: string }; // catch-all for interesting raw events during dev

export type Config = {
  socketPath: string;
  opencodeBin: string;
  opencodeArgs: string[];
  model?: string; // provider/model to pass per-session, if set
  agent?: string; // agent name to pass per-session, if set
  permissionsDefault: "wait" | "deny" | "allow";
  permissionsTimeout: number; // seconds; 0 = none
  dataDir: string; // ~/.harness-squared
  logPath: string;
  pidPath: string;
};
