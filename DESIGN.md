# harness² (harness-squared) — Design Spec

**One-line pitch:** A small Deno daemon + CLI (`h2`) that lets Claude Code (Opus, supervisor) dispatch coding tasks to pluggable executor backends (opencode, Gemini CLI, etc.) with the user able to observe, guide, and gate permissions mid-run.

**Status:** Exploratory prototype. Goal is to answer "is Opus-plans → cheap-executor-implements worth the coordination overhead?" — not to ship a polished tool.

---

## 1. Why this exists

- User has Claude Code Enterprise (Opus 4.6, great long-horizon reasoning, expensive) + z.ai GLM coding plan ($80/mo ≈ 10× the tokens of Claude Max $200 plan, strong on pedestrian coding tasks, weaker on long horizon).
- Anthropic ToS pins Claude to Claude Code. GLM is pinned to opencode (or its native CLI).
- Prior attempt: a `glm-executor` Claude Code subagent wrapping `opencode run` (stdio, one-shot). Failed because: no permission routing, no mid-run dialog, DONE/BLOCKED/ASSUMED marker protocol was unreliable, Opus tokens burned on wrapper overhead.
- New frame: **outer headless daemon** (harness²) drives opencode via its HTTP server mode, Claude calls the daemon via a small CLI (`h2`) using its existing `Bash` tool. The user watches and guides via separate CLI commands in tmux panes.

## 2. Non-goals for this exploration

- No cost/token tracking (available via provider APIs if needed later).
- No parallel jobs. One delegation at a time. Multi-job comes after single-job works.
- No persistence. Daemon holds jobs in memory. Daemon dies = jobs gone.
- No web UI, no TUI app. CLI + tmux only.
- No auth on the daemon socket — local-only, unix socket.
- No escalation state machine. If executor fails or gets stuck, surface the error to Claude; Claude decides whether to retry, abandon, or take over.
- No tests. Exploratory.

## 3. Process topology

```
     [ Claude Code (Opus) ]
              │
              │ calls `h2 delegate …` via Bash tool
              │ (Claude Code's own permission prompt gates each call)
              ▼
     ┌───────────────────────┐           ┌───────────────────────┐
     │   h2 CLI (one-shot)   │  ◀────▶   │   h2 daemon           │
     └───────────────────────┘  HTTP     │   (long-running)      │
                                over     └──────────┬────────────┘
     [ user, in a tmux pane ]  unix                │
              │                socket       ┌──────┴──────┐
              │ `h2 tail <id>`, `h2 send …` │  Adapter    │ Normalized events
              └──────────────────────────▶  │  boundary   │ Opaque session IDs
                                           └──────┬──────┘ Unified permissions
                                     ┌────────────┼────────────┐
                                     ▼            ▼            ▼
                              ┌────────────┐ ┌──────────┐ ┌──────────┐
                              │  opencode  │ │  gemini  │ │ (future) │
                              │  (HTTP+SSE)│ │(ACP/RPC) │ │          │
                              └────────────┘ └──────────┘ └──────────┘
```

- **Claude Code ↔ h2 CLI:** shell subprocess invocation, via Claude's `Bash` tool. No special integration. Each call is gated by Claude Code's normal Bash permission prompt.
- **h2 CLI ↔ h2 daemon:** HTTP over a unix socket (use `Deno.serve({ path })`). One-shot commands that post/fetch, plus one long-lived SSE subscription for `tail`.
- **h2 daemon ↔ ExecutorAdapter:** daemon routes each job to the configured adapter. The adapter boundary normalizes events, session IDs, and permissions across backends.
- **ExecutorAdapter ↔ backends:** each adapter speaks its backend's native protocol (opencode: HTTP + SSE; Gemini CLI: ACP JSON-RPC over stdio; etc.). Daemon owns child process lifecycle where applicable.
- **User ↔ h2 CLI:** user runs `h2 tail`, `h2 send`, `h2 approve` in a separate tmux pane to observe/guide jobs.

## 4. Repo layout

```
harness-squared/
├── README.md                       # quick-start, not spec
├── DESIGN.md                       # this file
├── deno.json                       # deno config, tasks (start, build, fmt, lint)
├── deno.lock
├── src/
│   ├── cli/
│   │   ├── main.ts                 # entrypoint; dispatches to commands/
│   │   ├── ipc.ts                  # HTTP client over unix socket
│   │   ├── format.ts               # table/json output helpers
│   │   └── commands/
│   │       ├── start.ts            # launch daemon (detached) + opencode serve
│   │       ├── stop.ts             # kill daemon + opencode
│   │       ├── delegate.ts         # POST /jobs
│   │       ├── jobs.ts             # GET /jobs
│   │       ├── status.ts           # GET /jobs/:id
│   │       ├── output.ts           # GET /jobs/:id/output (final assistant msg)
│   │       ├── tail.ts             # SSE subscription + interactive perms
│   │       ├── send.ts             # POST /jobs/:id/messages
│   │       ├── approve.ts          # POST /jobs/:id/permissions/:permId (allow)
│   │       ├── deny.ts             # same, deny
│   │       └── abort.ts            # POST /jobs/:id/stop
│   ├── daemon/
│   │   ├── main.ts                 # daemon entry
│   │   ├── server.ts               # HTTP routes over unix socket
│   │   ├── jobs.ts                 # Job lifecycle + in-memory store
│   │   ├── opencode_client.ts      # typed wrappers around opencode REST
│   │   ├── opencode_events.ts      # subscribes to opencode SSE, translates
│   │   ├── opencode_process.ts     # spawns/supervises `opencode serve` child
│   │   ├── events.ts               # per-job event hub for SSE fan-out
│   │   └── permissions.ts          # pending-permission queue + routing
│   ├── shared/
│   │   ├── types.ts                # Job, Event, Permission, Config
│   │   ├── paths.ts                # socket path, config path, log path
│   │   └── log.ts                  # stderr logger for daemon
│   └── config.ts                   # load/validate ~/.config/harness-squared/config.toml
├── scripts/
│   └── install.sh                  # deno compile → ~/.local/bin/h2
└── examples/
    └── claude_instructions.md      # suggested text for ~/.claude/CLAUDE.md
```

## 5. Data model

```ts
// shared/types.ts

type JobState = "pending" | "running" | "done" | "error" | "stopped";

type Job = {
  id: string;                    // "job_" + random(12)
  task: string;                  // verbatim task text passed to delegate
  sessionId: string;             // opencode session id
  state: JobState;
  createdAt: string;             // ISO 8601
  updatedAt: string;
  finalOutput?: string;          // populated on state=done
  error?: string;                // populated on state=error
};

type PermissionRequest = {
  id: string;                    // opencode's permissionID (use theirs directly)
  jobId: string;
  description: string;           // human-readable
  toolName?: string;
  input?: unknown;
  createdAt: string;
  resolved: boolean;
  response?: "allow" | "deny";
};

type Event =
  | { type: "status"; state: JobState }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.use"; name: string; input: unknown }
  | { type: "tool.result"; name: string; output: unknown }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "permission.resolved"; id: string; response: "allow" | "deny" }
  | { type: "job.done"; summary?: string }
  | { type: "job.error"; error: string };
```

## 6. Daemon HTTP API (exposed to CLI over unix socket)

Base path: `/` on `$HOME/.harness-squared/daemon.sock`.

| Method | Path                                      | Body                                      | Returns                          | Purpose                                 |
|--------|-------------------------------------------|-------------------------------------------|----------------------------------|-----------------------------------------|
| GET    | `/health`                                 | —                                         | `{ok: true, pid}`                | Liveness probe.                         |
| POST   | `/jobs`                                   | `{task: string}`                          | `{id, sessionId, state}`         | Create & start a delegation.            |
| GET    | `/jobs`                                   | —                                         | `Job[]`                          | List all jobs (most recent first).      |
| GET    | `/jobs/:id`                               | —                                         | `Job`                            | Single job status.                      |
| GET    | `/jobs/:id/output`                        | —                                         | `{text: string}` or 409 if !done | Final assistant message text.           |
| POST   | `/jobs/:id/messages`                      | `{content: string}`                       | `{ok: true}`                     | Inject user message into live session.  |
| POST   | `/jobs/:id/stop`                          | —                                         | `{ok: true}`                     | Abort running job.                      |
| GET    | `/jobs/:id/events`                        | — (SSE)                                   | event stream                     | Live events for this job.               |
| GET    | `/jobs/:id/permissions`                   | —                                         | `PermissionRequest[]`            | Pending permission requests.            |
| POST   | `/jobs/:id/permissions/:permId`           | `{response: "allow"\|"deny", remember?}`  | `{ok: true}`                     | Resolve a permission request.           |

**Errors:** standard HTTP status codes, JSON body `{error: string}`.

**SSE format:** standard `text/event-stream`. Each event is a JSON-encoded `Event` (see section 5).

## 7. Daemon ↔ opencode bridge

Daemon speaks opencode's HTTP API. Relevant endpoints (verify against `/docs/server/` when implementing):

- `POST /session` — create session.
- `POST /session/:id/message` — send user message (used both for initial task and mid-run `h2 send`).
- `POST /session/:id/permissions/:permissionID` — respond to permission (daemon forwards from CLI).
- `GET /global/event` — SSE stream of all opencode events.

**Event translation (opencode → h2 internal Event):**

| opencode event                | h2 Event                                           |
|-------------------------------|----------------------------------------------------|
| `message.part.updated` (text) | `assistant.delta`                                  |
| `message.part.updated` (tool) | `tool.use`                                         |
| `tool.result`                 | `tool.result`                                      |
| `permission.updated` (new)    | `permission.request` + store in `permissions.ts`   |
| `permission.updated` (resolv.)| `permission.resolved`                              |
| `session.idle` or `session.done` | `job.done` + update Job.state=done, capture finalOutput |
| `session.error`               | `job.error` + update Job.state=error               |

The daemon keeps a single long-lived SSE subscription to `/global/event` and demultiplexes by session id to each Job's event hub.

## 8. Process lifecycle

**`h2 start`:**
1. If daemon already running (socket exists + `/health` responds), exit 0.
2. Start `opencode serve` as a detached child on a free localhost port. Capture the port.
3. Spawn the daemon (detached), passing the opencode port via env. Daemon writes pid + opencode pid to `~/.harness-squared/pids`.
4. Wait for `/health` to respond, then return.

**`h2 stop`:**
1. `POST /shutdown` (or signal) to daemon.
2. Daemon stops opencode child, drains, exits.
3. Remove socket + pid files.

**Daemon crash:** CLI commands return a clear "daemon not running, run `h2 start`" error.

## 9. Key flows

### 9.1 Delegation (happy path)

1. Claude runs `h2 delegate "refactor src/foo.ts to use zod"` via Bash.
2. Claude Code prompts user for Bash approval; user approves.
3. `h2 delegate` posts `POST /jobs {task}` to daemon.
4. Daemon creates opencode session, posts first message, records Job with sessionId, returns `{id: "job_abc", ...}`.
5. CLI prints `job_abc` and exits. Claude captures it.
6. User runs `h2 tail job_abc` in a separate tmux pane → subscribes to `GET /jobs/job_abc/events` (SSE).
7. Opencode proceeds; daemon translates events; user sees assistant text and tool calls stream in.
8. On `job.done`, daemon stores `finalOutput`.
9. Claude polls `h2 status job_abc` or is instructed to do so after a wait; sees `done`; runs `h2 output job_abc` to get the final message text into Claude's context.
10. Claude uses its own Read tool to verify file changes if needed.

### 9.2 Mid-run permission gate

1. During step 7 above, opencode emits a `permission.updated` event (e.g., "write file src/foo.ts").
2. Daemon stores the PermissionRequest and emits `permission.request` on the job's event stream.
3. User's `h2 tail` pane shows:
   ```
   [permission] write src/foo.ts  — [y]es / [n]o / [a]lways  ?
   ```
4. User presses `y`. `h2 tail` posts `POST /jobs/:id/permissions/:permId {response:"allow"}`.
5. Daemon forwards to opencode. Opencode proceeds.
6. Emits `permission.resolved` on the event stream for any other observers.

**If nobody is tailing:** permission sits pending. Job blocks. Acceptable — this is the exploratory MVP. Later: configurable default-deny timeout.

**Non-interactive approval:** user can also run `h2 approve <job-id> <perm-id>` from anywhere to resolve pending permissions listed by `h2 status`.

### 9.3 Mid-run user guidance

1. User notices GLM is about to go off the rails (e.g., creating a useless abstraction).
2. User runs `h2 send job_abc "don't extract a helper, inline it"`.
3. CLI posts `POST /jobs/job_abc/messages {content}`.
4. Daemon calls opencode's `POST /session/:id/message`. Opencode delivers as a new user message to the running session. GLM adjusts.

### 9.4 Failure

- Opencode session errors: daemon marks Job.state=error, finalizes `error` field, emits `job.error`.
- CLI `h2 output` on an errored job returns the error text with non-zero exit, so Claude sees the failure in Bash output.
- Claude decides: retry with adjusted prompt, abandon, or take over directly.

## 10. Config

`~/.config/harness-squared/config.toml`:

```toml
[daemon]
# socket path override; defaults to ~/.harness-squared/daemon.sock
# socket = "..."

[opencode]
# path to opencode binary; defaults to looking on PATH
# bin = "opencode"
# additional args passed to `opencode serve`
# args = []
# model override — if unset, use whatever opencode config provides
model = "zai-coding-plan/glm-5.1"

[permissions]
# default if nobody is tailing when prompt arrives:
# "wait" (block forever until resolved), "deny" (auto-deny after timeout), "allow" (dangerous)
default = "wait"
# timeout for non-"wait" modes, in seconds
# timeout = 300
```

Loader: parse on daemon start; for v0.1 most fields can be absent and hardcoded defaults apply.

## 11. Claude-side integration

Single block added to `~/.claude/CLAUDE.md`, something like:

```markdown
## Delegating via harness² (h2)

For implementation tasks that are well-scoped and mechanical (boilerplate, tests,
refactors, format conversions, mechanical edits across files), delegate to the
h2 daemon rather than writing code yourself. Use your Bash tool:

- `h2 delegate "<task with exact paths and constraints>"` — returns a job id
- `h2 status <id>` — check state (running/done/error)
- `h2 output <id>` — fetch the final result once done
- `h2 abort <id>` — kill a job that's off the rails

Between delegate and status, do something else useful or wait briefly. The
user can watch the job in another pane with `h2 tail <id>` and will intervene
if needed.

Do NOT delegate:
- Cross-file architectural decisions or API design
- Security-sensitive changes (auth, crypto, permissions)
- Tasks where the "right answer" is judgment-heavy rather than mechanical
- Anything destructive without user confirmation first
```

(The implementer should leave this as an example file in `examples/` and note in the README that the user decides when/how to install it.)

## 12. Implementation notes for the next agent

- **Language/runtime:** Deno (≥ 2.x). No Node, no Bun. TypeScript throughout.
- **Deps:** prefer Deno std library. For TOML parsing, use `@std/toml`. For CLI arg parsing, `@std/cli/parse-args`. No heavyweight frameworks.
- **opencode HTTP client:** hand-write typed wrappers in `src/daemon/opencode_client.ts` using `fetch`. Do not autogenerate from their OpenAPI spec. Small surface (~8 calls), hand-written is clearer.
- **Unix socket HTTP:** `Deno.serve({ path: socketPath, handler })`. Client side: `fetch` in Deno supports unix sockets via a custom client (`Deno.createHttpClient({ proxy: ... })` — check current Deno API; if it's awkward, fall back to a tiny HTTP-over-unix-socket helper using `Deno.connect({ path, transport: "unix" })` and writing request bytes directly).
- **SSE parsing:** use `EventSource` if it works over unix sockets in Deno; otherwise implement a minimal SSE parser (~30 lines — split on `\n\n`, parse `event:`/`data:` lines).
- **Daemonization:** on macOS, `deno run --detach` equivalent isn't built in. Spawn with `Deno.Command` and `stdin/stdout/stderr: "null"`, detach from parent, write logs to `~/.harness-squared/daemon.log`. Revisit if this is flaky.
- **Job ID generation:** `"job_" + crypto.randomUUID().replaceAll("-","").slice(0,12)`.
- **Don't over-engineer error paths.** This is exploratory. Happy path + clear errors on the obvious failure modes is enough.

## 13. Open questions the implementer should answer early

1. **How exactly does `opencode serve` surface permission events?** Confirm `permission.updated` event shape against a live server before wiring up `permissions.ts`. If the event shape is different, adjust the translation table in section 7.
2. **Can the daemon safely survive the CLI `h2 start` process exiting?** macOS detach semantics are fiddly. If `Deno.Command` doesn't cleanly detach, consider having `h2 start` exec into the daemon (`Deno.Command + stdin:null + setsid`) or instruct the user to run the daemon under `launchd` / a tmux pane.
3. **Does opencode's model config live in its own config file, or can the daemon pass model choice per-session?** Affects whether the `model` field in `config.toml` is the daemon's job to enforce or opencode's. Check before implementing.
4. **What's the SSE heartbeat behavior?** If opencode doesn't send keepalives, long-idle connections may drop through intermediaries. Probably fine on localhost; note for later.

## 14. Success criteria for v0.1

The following end-to-end flow works:

1. User runs `h2 start`.
2. User (or Claude via simulated Bash call) runs `h2 delegate "add a license header comment to all .ts files in ./src"`.
3. User runs `h2 tail <id>` in another pane.
4. GLM proceeds, emits a permission request when trying to write the first file.
5. User approves with `y`. GLM proceeds to completion.
6. User runs `h2 send <id> "..."` successfully mid-run on a longer task, and GLM responds to the guidance.
7. After `done`, `h2 output <id>` returns a useful summary.
8. `h2 stop` cleanly shuts both processes down.

If all that works, the architecture is validated. Whether it's *worth it* compared to using opencode directly is a separate judgment the user makes after living with it.
