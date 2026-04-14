// Shared types between daemon and CLI.
// Event wire-format (as emitted by the daemon on /jobs/:id/events) is the
// set of h2-internal Event types, NOT raw executor events.

/**
 * Represents the lifecycle state of a delegated job.
 * - `"pending"` — queued, waiting for a worker.
 * - `"running"` — actively executing inside an executor session.
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
 * @property sessionId - Opaque executor session identifier.
 * @property executor - Name of the executor backend that owns this job.
 * @property state - Current lifecycle state of the job.
 * @property createdAt - ISO 8601 timestamp when the job was created.
 * @property updatedAt - ISO 8601 timestamp of the last state change.
 * @property finalOutput - Final text output; populated when `state` is `"done"`.
 * @property error - Error message; populated when `state` is `"error"`.
 */
export type Job = {
  id: string; // "job_" + 12 hex chars
  task: string; // verbatim task text
  sessionId: string; // opaque executor session id
  executor?: string; // executor backend name (e.g. "opencode", "gemini")
  cwd?: string; // working directory for the executor process
  model?: string; // model override for this job
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
 * A normalised permission request forwarded from the executor to the h2 CLI.
 *
 * Fields are executor-agnostic but include a pre-built human-readable
 * `description` for display in the UI.
 *
 * @property id - Executor's permission request identifier (opaque).
 * @property jobId - The h2 job that triggered this request.
 * @property permission - Permission category (e.g. `"edit"`, `"bash"`, `"webfetch"`).
 * @property patterns - File path or glob patterns the permission applies to.
 * @property description - Pre-built human-readable description for the UI.
 * @property toolCallId - Tool call identifier, if applicable.
 * @property messageId - Message identifier, if applicable.
 * @property metadata - Arbitrary extra data from the executor.
 * @property createdAt - ISO 8601 timestamp when the request was created.
 * @property resolved - Whether the request has been answered.
 * @property response - The user's response, once resolved.
 */
export type PermissionRequest = {
  id: string; // executor's permission id (opaque)
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
 * These are h2-internal event types, not raw executor events.
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
 * @property defaultExecutor - Name of the default executor backend.
 * @property executors - Per-executor configuration keyed by name.
 * @property permissionsDefault - Default behaviour when a permission prompt is not answered in time.
 * @property permissionsTimeout - Seconds before the default permission behaviour kicks in; `0` means no timeout.
 * @property dataDir - Root data directory (defaults to `~/.harness-squared`).
 * @property logPath - File path for the daemon log output.
 * @property pidPath - File path where the daemon writes its PID.
 */
export type Config = {
  socketPath: string;
  defaultExecutor: string;
  executors: Record<
    string,
    {
      type: "opencode" | "gemini";
      bin: string;
      args: string[];
      model?: string;
      agent?: string;
    }
  >;
  permissionsDefault: "wait" | "deny" | "allow";
  permissionsTimeout: number; // seconds; 0 = none
  dataDir: string; // ~/.harness-squared
  logPath: string;
  pidPath: string;
};
