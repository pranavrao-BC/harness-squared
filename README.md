# harness²

Claude Code (Opus) delegates coding tasks to pluggable executor backends (opencode, Gemini CLI, ...) via a Deno daemon. You watch and approve permissions in a separate pane.

```
CLI (h2)  ──unix socket──▶  daemon  ──▶  ExecutorAdapter  ──▶  { opencode | gemini-cli | ... }
                                       ┌──────────┐
                                       │ Adapter  │  Normalized events, opaque session IDs
                                       │ boundary │  Unified permission handling
                                       └──────────┘
                                               ▲
                                               │  h2 tail / approve
                                               you (tmux pane)
```

## Install

```bash
brew install deno                    # if you don't have it
opencode providers login             # authenticate at least one provider

git clone https://github.com/pranavrao-BC/harness-squared.git
cd harness-squared
./scripts/install.sh                 # compiles h2 → ~/.local/bin/h2
```

## Setup

1. Configure executors:

```bash
mkdir -p ~/.config/harness-squared
cat > ~/.config/harness-squared/config.toml << 'EOF'
executor = "opencode"             # default executor for new jobs

[opencode]
model = "zai-coding-plan/glm-5.1"

[gemini]
bin = "gemini"
model = "gemini-3-flash"
EOF
```

2. Tell Claude Code about h2:

```bash
cat examples/claude_instructions.md >> ~/.claude/CLAUDE.md
```

## How to use

Three panes.

**Pane 1** — start the daemon:
```bash
h2 start
```

**Pane 2** — Claude Code. Ask it to delegate work. It calls `h2 exec` via Bash:

```bash
claude
> "add JSDoc to every exported function in src/shared/"
```

Claude writes a script like:

```js
h2 exec << 'SCRIPT'
const files = ["types.ts", "sse.ts", "log.ts", "paths.ts"];
const ids = await Promise.all(
  files.map(f => h2.delegate("add JSDoc to src/shared/" + f))
);
await Promise.all(ids.map(id => h2.wait(id)));
for (const id of ids) console.log(await h2.output(id));
SCRIPT
```

**Pane 3** — watch what the executor is doing:
```bash
h2 tail <job-id>
```

Permission prompts appear here. Press `y` to allow, `a` for always, `n` to deny.

Or attach to a specific executor's native UI (opencode only):
```bash
opencode attach http://127.0.0.1:$(cat ~/.harness-squared/pids.json | grep opencodePort | grep -o '[0-9]*')
```

Stop:
```bash
h2 stop
```

## The h2 exec API

Claude writes JS scripts against these functions:

| Function | What it does |
|---|---|
| `h2.run(task, opts?)` | Delegate + wait + return session log. One call. |
| `h2.delegate(task, opts?)` | Create a job, return its id. |
| `h2.wait(id)` | Block until job finishes. |
| `h2.output(id)` | Session log: user msgs, tool calls, errors, final text. |
| `h2.send(id, msg)` | Send guidance mid-run, or resume an errored job. |
| `h2.abort(id)` | Kill a job. |
| `h2.status(id)` | Get current job state. |
| `h2.plan(tasks)` | Create multiple jobs with dependency graph. |
| `h2.history(n)` | Past jobs (persists across daemon restarts). |

`opts` can include `{ executor: "gemini" }` to route a task to a specific backend. Without it, the default from config is used.

Use `Promise.all` for parallel tasks. Pass output of one task into the next with string interpolation. Standard JS — Claude knows how to write it.

## CLI commands (for humans)

| Command | What it does |
|---|---|
| `h2 start` / `h2 stop` | Daemon lifecycle |
| `h2 tail <id>` | Live event stream + interactive permission prompts |
| `h2 board` | Kanban view of all jobs |
| `h2 history` | Past delegations |
| `h2 status <id>` | Job state + pending permissions |
| `h2 approve <id> <perm>` | Allow a permission from any pane |
| `h2 deny <id> <perm>` | Deny a permission |
| `h2 send <id> "<msg>"` | Steer a running job or resume an errored one |
| `h2 abort <id>` | Kill a job |
| `h2 jobs` | List all jobs |

## How it works

1. `h2 exec` runs a JS script in-process with the `h2` API object injected.
2. `h2.delegate()` POSTs to the daemon, which picks the configured executor adapter and creates a session.
3. The adapter translates backend-specific events (tool calls, permissions, completion) into h2's normalized event format and publishes them to a per-job event hub.
4. `h2.wait()` subscribes to the daemon's SSE for that job and blocks until terminal.
5. Permission requests from any backend bubble up to `h2 tail`. Approvals flow back through the daemon to the executor.
6. `h2.output()` fetches the normalized message history and renders a condensed log.
7. Jobs re-activate if the user continues the session via `h2.send()` or the executor's native UI.

## Executor backends

### opencode

Spawns `opencode serve` as a child process. Communicates via HTTP + SSE. Supports the `opencode attach` TUI for direct inspection.

### Gemini CLI

Uses [ACP (Agent Client Protocol)](https://agentclientprotocol.com) — JSON-RPC 2.0 over stdio. The daemon spawns `gemini --acp` and communicates bidirectionally: requests to Gemini for prompting/sessions, and Gemini sends back notifications (streaming chunks, tool calls, permission requests). No HTTP involved.

Per-task routing:
```js
await h2.run("refactor utils.ts", { executor: "gemini" })
```

## Notes

- Use **absolute paths** in task descriptions. Executor sessions inherit the daemon's cwd.
- Route tasks to specific backends with `{ executor: "gemini" }` or let them use the default from config.
- In `h2.plan()`, each task object can include `executor` to mix backends in one plan.
- Jobs survive errors. `h2.send(id, "continue")` resumes. No subscription teardown.
- History persists to `~/.harness-squared/history.jsonl`. Daemon restarts lose in-flight jobs but history stays.
- The plan system (via `h2.plan()`) auto-dispatches tasks as dependencies clear, up to 3 concurrent.

## Config

`~/.config/harness-squared/config.toml`:

```toml
executor = "opencode"                  # default executor for new jobs

[opencode]
model = "zai-coding-plan/glm-5.1"     # provider/model per session
# bin = "opencode"                     # opencode binary path
# args = []                            # extra args to opencode serve

[gemini]
bin = "gemini"                         # gemini binary path
model = "gemini-3-flash"               # model name
# args = []                            # extra args to gemini --acp

[permissions]
# default = "wait"                     # "wait", "deny", or "allow"

[daemon]
# socket = "~/.harness-squared/daemon.sock"
```

## Design

[DESIGN.md](./DESIGN.md) has the full architecture spec.
