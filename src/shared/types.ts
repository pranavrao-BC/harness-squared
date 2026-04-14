// Shared types between daemon and CLI. See DESIGN.md §5.
// Event wire-format (as emitted by the daemon on /jobs/:id/events) is the
// set of h2-internal Event types, NOT raw opencode events.

/**
 * Represents the lifecycle state of a delegated job.
 * - `"pending"` — queued, waiting for a worker.
 * - `"running"` — actively executing inside an opencode session.
 * - `"done"` — completed successfully; `finalOutput` is populated.
 * - `"error"` — terminated with an error; `error` is populated.
 * - `"stopped"` — externally stopped (e.g. `h2 abort`).
 */
export type JobState = "pending" | "running" | "done" | "error" | "stopped";

/**
 * A delegated task managed by the h2 daemon.
 *
 * @property id - Unique identifier (`"job_"` + 12 hex characters).
 * @property task - Verbatim task text provided by the caller.
 * @property sessionId - Opencode session identifier (`"ses_*"`).
 * @property state - Current lifecycle state of the job.
 * @property createdAt - ISO 8601 timestamp when the job was created.
 * @property updatedAt - ISO 8601 timestamp of the last state change.
 * @property finalOutput - Final text output; populated when `state` is `"done"`.
 * @property error - Error message; populated when `state` is `"error"`.
 */
export type Job = {
  id: string; // "job_" + 12 hex chars
  task: string; // verbatim task text
  sessionId: string; // opencode session id (ses_*)
  state: JobState;
  createdAt: string; // ISO 8601
  updatedAt: string;
  finalOutput?: string; // populated on state=done
  error?: string; // populated on state=error
  planId?: string; // if part of a plan
  deps?: string[]; // job ids that must complete before this can dispatch
};

export type Plan = {
  id: string; // "plan_" + 12 hex chars
  jobIds: string[];
  createdAt: string;
};

/**
 * A normalised permission request forwarded from opencode to the h2 CLI.
 *
 * Fields map to opencode's internal `PermissionRequest` but include a
 * pre-built human-readable `description` for display in the UI.
 *
 * @property id - Opencode's permission request identifier (`"per_*"`).
 * @property jobId - The h2 job that triggered this request.
 * @property permission - Permission category (e.g. `"edit"`, `"bash"`, `"webfetch"`).
 * @property patterns - File path or glob patterns the permission applies to.
 * @property description - Pre-built human-readable description for the UI.
 * @property toolCallId - Opencode tool call identifier, if applicable.
 * @property messageId - Opencode message identifier, if applicable.
 * @property metadata - Arbitrary extra data from opencode.
 * @property createdAt - ISO 8601 timestamp when the request was created.
 * @property resolved - Whether the request has been answered.
 * @property response - The user's response, once resolved.
 */
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

/**
 * The user's decision on a permission request.
 * - `"once"` — allow this one invocation.
 * - `"always"` — allow all future invocations for the same pattern.
 * - `"reject"` — deny the request.
 */
export type PermissionResponse = "once" | "always" | "reject";

/**
 * Discriminated union of events emitted on the h2 SSE stream (`/jobs/:id/events`).
 *
 * These are h2-internal event types, not raw opencode events.
 *
 * @property type - Discriminant identifying the event kind.
 * @property state - (status) New `JobState` of the job.
 * @property text - (assistant.delta) Incremental text from the assistant.
 * @property partId - (assistant.delta) Identifier for the current text part.
 * @property name - (tool.use / tool.result) Tool name being invoked.
 * @property callId - (tool.use / tool.result) Unique tool call identifier.
 * @property input - (tool.use) Tool input payload.
 * @property state - (tool.use) Optional tool execution state hint.
 * @property output - (tool.result) Tool output payload.
 * @property error - (tool.result / job.error) Error message, if the tool or job failed.
 * @property request - (permission.request) The full `PermissionRequest` object.
 * @property id - (permission.resolved) The permission request identifier that was resolved.
 * @property response - (permission.resolved) The chosen `PermissionResponse`.
 * @property summary - (job.done) Optional human-readable summary of the completed job.
 */
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

/**
 * Daemon configuration loaded from the config file and/or environment variables.
 *
 * @property socketPath - Unix domain socket path for the IPC server.
 * @property opencodeBin - Path to the `opencode` binary.
 * @property opencodeArgs - Additional CLI arguments forwarded to every opencode invocation.
 * @property model - Optional `provider/model` string passed per-session.
 * @property agent - Optional agent name passed per-session.
 * @property permissionsDefault - Default behaviour when a permission prompt is not answered in time (`"wait"`, `"deny"`, or `"allow"`).
 * @property permissionsTimeout - Seconds before the default permission behaviour kicks in; `0` means no timeout.
 * @property dataDir - Root data directory (defaults to `~/.harness-squared`).
 * @property logPath - File path for the daemon log output.
 * @property pidPath - File path where the daemon writes its PID.
 */
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
