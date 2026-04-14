# harness²

Deno 2.x daemon + CLI (`h2`) that dispatches tasks to pluggable executor backends (opencode, Gemini CLI, ...). ~3.5k LOC TypeScript.

## Architecture

Two processes: daemon (long-running, owns executor backends) and CLI (one-shot commands).

```
CLI (h2) ──unix socket──▶ daemon ──▶ ExecutorAdapter ──▶ { opencode | gemini-cli | ... }
                                          │
                                     ┌────┴────┐
                                     │ Adapter  │  Normalized events
                                     │ boundary │  Opaque session IDs
                                     └────┬────┘  Unified permissions
                                          │
                              ┌───────────┼───────────┐
                              ▼           ▼           ▼
                         opencode    gemini-cli    (future)
                        HTTP + SSE   ACP/JSON-RPC   ...
```

## Where things live

**Daemon** (`src/daemon/`) — the core:
- `jobs.ts` — job lifecycle, plan system, dispatch loop, event handling. Backend-agnostic: depends only on `ExecutorAdapter` interface. **Start here for any feature work.**
- `server.ts` — HTTP routes over unix socket. Maps to jobs.ts methods 1:1.
- `events.ts` — per-job pub/sub hub with replay buffer.
- `permissions.ts` — pending permission queue per job.
- `history.ts` — append-only JSONL log at `~/.harness-squared/history.jsonl`.
- `main.ts` — boots executors via factory, wires shutdown.

**Executor adapters** (`src/daemon/executor/`) — the abstraction layer:
- `types.ts` — `ExecutorAdapter` interface, `NormalizedMessage`, `NormalizedPart`, `ExecutorConfig`. Read this to understand the adapter contract.
- `factory.ts` — reads config, instantiates + starts all configured adapters.
- `opencode/adapter.ts` — `OpencodeAdapter` wrapping client/events/process.
- `opencode/client.ts` — typed HTTP wrappers for opencode's API.
- `opencode/events.ts` — SSE subscriber that translates opencode events → h2 events.
- `opencode/process.ts` — spawns/supervises `opencode serve` child.
- `gemini/adapter.ts` — `GeminiAdapter` using ACP (JSON-RPC over stdio).
- `gemini/acp.ts` — bidirectional JSON-RPC 2.0 client over stdin/stdout.

**CLI** (`src/cli/`) — thin layer over IPC:
- `main.ts` — command dispatcher. Also contains the `__daemon` entry for compiled binary.
- `ipc.ts` — hand-rolled HTTP/1.1 client over unix socket. Supports chunked, content-length, and SSE streaming.
- `commands/exec.ts` — **the primary agent interface**. Evals JS with an injected `h2` API object. All orchestration flows through here. Supports `{ executor }` option for per-task routing.
- `commands/tail.ts` — SSE consumer with interactive permission prompts.
- `commands/` — each file is one CLI subcommand (~15-50 LOC each).

**Shared** (`src/shared/`):
- `types.ts` — `Job`, `Plan`, `Event`, `PermissionRequest`, `Config`. Read this to understand the data model.
- `sse.ts` — SSE parser/encoder used by both daemon and CLI.
- `paths.ts` — socket, log, pid, config file paths.
- `log.ts` — stderr logger.

## Key concepts

- **Job** = one executor session executing one task. States: pending → running → done/error/stopped. Each job records which executor backend owns it.
- **ExecutorAdapter** = the interface every backend must implement: `createSession`, `prompt`, `subscribe`, `abort`, `respondPermission`, `listMessages`. Plus `idleSignals`/`activeSignals` for lifecycle transitions.
- **Plan** = batch of jobs with a dependency graph. Dispatch loop auto-dispatches as deps clear (max 3 concurrent). Each task can specify its own executor.
- **h2 exec** = agent writes JS against `h2.run()`, `h2.delegate()`, `h2.wait()`, etc. One Bash call, scriptable orchestration. Supports `{ executor: "gemini", model: "gemini-3-flash" }` for per-task routing and model override.
- **Escalation** = executor tags findings with `[ESCALATE]`. `h2.output()` hoists these above the log.
- **Retry** = jobs that crash (process exit, adapter error) auto-retry up to maxRetries times with exponential backoff (2s, 4s, 8s...). Model-level errors (the agent itself errored) are NOT retried.
- **Permissions** = tool approval requests from any executor bubble up to `h2 tail` for interactive approval.

## Data flow for a delegation

1. `h2.delegate(task, { executor })` → POST `/jobs` → daemon picks the right adapter
2. Adapter creates a session and subscribes to backend events
3. Adapter translates raw events → h2 `Event` types → published to job's `EventHub`
4. `h2.wait()` subscribes to daemon SSE (`/jobs/:id/events`), blocks on terminal event
5. `h2.output()` fetches messages from the adapter, renders condensed log

## Running

```bash
deno task daemon    # run daemon from source
deno task cli       # run CLI from source
deno task compile   # build single binary
deno task check     # typecheck
```

## Config

`~/.config/harness-squared/config.toml`:

```toml
executor = "opencode"          # default executor for new jobs
maxRetries = 1                 # retry crashed jobs (0 = no retry)

# New format: named executors under [executors.*]
[executors.opencode]
type = "opencode"
model = "zai-coding-plan/glm-5.1"

[executors.gemini-flash]
type = "gemini"
model = "gemini-3-flash"

[executors.gemini-pro]
type = "gemini"
model = "gemini-3.1-pro"
yolo = false                   # require permission approval (default: true)

# Legacy format still works:
# [opencode]
# model = "..."
# [gemini]
# model = "..."

[permissions]
default = "wait"
```

## Adding a new executor

1. Create `src/daemon/executor/<name>/adapter.ts` implementing `ExecutorAdapter`
2. Add a case to `factory.ts::buildAdapter()`
   3. Add an `[executors.<name>]` section to config.toml with `type = "<name>"`
4. That's it — jobs.ts, server.ts, and the CLI are already backend-agnostic.

## Tests

None. Exploratory prototype. Verify via:
```bash
h2 start
h2 exec 'console.log(await h2.run("say ok"))'                                                # default executor
h2 exec 'console.log(await h2.run("say ok", { executor: "gemini" }))'                        # gemini executor
h2 exec 'console.log(await h2.run("say ok", { executor: "gemini", model: "gemini-3-flash" }))' # model override
```
