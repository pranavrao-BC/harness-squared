# harness²

Deno 2.x daemon + CLI (`h2`) that bridges Claude Code to opencode. ~2.9k LOC TypeScript.

## Architecture

Two processes: daemon (long-running, owns opencode) and CLI (one-shot commands).

```
CLI (h2) ──unix socket──▶ daemon ──HTTP/SSE──▶ opencode serve ──▶ LLM provider
```

## Where things live

**Daemon** (`src/daemon/`) — the core:
- `jobs.ts` (422 LOC) — job lifecycle, plan system, dispatch loop, event handling. **Start here for any feature work.**
- `server.ts` — HTTP routes over unix socket. Maps to jobs.ts methods 1:1.
- `opencode_client.ts` — typed HTTP wrappers for opencode's API (session, message, permission, abort).
- `opencode_events.ts` — SSE subscriber that translates opencode events → h2 events. Event mapping lives here.
- `opencode_process.ts` — spawns/supervises the `opencode serve` child.
- `events.ts` — per-job pub/sub hub with replay buffer.
- `permissions.ts` — pending permission queue per job.
- `history.ts` — append-only JSONL log at `~/.harness-squared/history.jsonl`.
- `main.ts` — boots everything, wires shutdown.

**CLI** (`src/cli/`) — thin layer over IPC:
- `main.ts` — command dispatcher. Also contains the `__daemon` entry for compiled binary.
- `ipc.ts` (282 LOC) — hand-rolled HTTP/1.1 client over unix socket. Supports chunked, content-length, and SSE streaming.
- `commands/exec.ts` — **the primary agent interface**. Evals JS with an injected `h2` API object. All orchestration flows through here.
- `commands/tail.ts` — SSE consumer with interactive permission prompts.
- `commands/` — each file is one CLI subcommand (~15-50 LOC each).

**Shared** (`src/shared/`):
- `types.ts` — `Job`, `Plan`, `Event`, `PermissionRequest`, `Config`. Read this to understand the data model.
- `sse.ts` — SSE parser/encoder used by both daemon and CLI.
- `paths.ts` — socket, log, pid, config file paths.
- `log.ts` — stderr logger.

## Key concepts

- **Job** = one opencode session executing one task. States: pending → running → done/error/stopped. Can re-activate from any terminal state.
- **Plan** = batch of jobs with a dependency graph. Dispatch loop auto-dispatches as deps clear (max 3 concurrent).
- **h2 exec** = agent writes JS against `h2.run()`, `h2.delegate()`, `h2.wait()`, etc. One Bash call, scriptable orchestration.
- **Escalation** = executor tags findings with `[ESCALATE]`. `h2.output()` hoists these above the log.
- **Permissions** = opencode permission requests bubble up to `h2 tail` for interactive approval.

## Data flow for a delegation

1. `h2.delegate(task)` → POST `/jobs` → daemon creates opencode session, fires `prompt_async`
2. Daemon subscribes to opencode SSE (`/event`), demuxes by sessionID
3. `opencode_events.ts` translates raw events → h2 `Event` types → published to job's `EventHub`
4. `h2.wait()` subscribes to daemon SSE (`/jobs/:id/events`), blocks on terminal event
5. `h2.output()` fetches full message list from opencode, renders condensed log

## Running

```bash
deno task daemon    # run daemon from source
deno task cli       # run CLI from source
deno task compile   # build single binary
deno task check     # typecheck
```

## Config

`~/.config/harness-squared/config.toml` — model, permissions default, socket path. See `src/config.ts`.

## Tests

None. Exploratory prototype. Verify via `h2 start` → `h2 exec 'console.log(await h2.run("say ok"))'`.
