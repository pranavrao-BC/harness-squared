# harness²

A harness for harnesses. Claude Code (Opus) delegates mechanical coding tasks to opencode (GLM, Gemini Flash, etc.) through a small Deno daemon, while you observe and gate permissions in a separate pane.

```
Claude Code (Opus)  ──h2 delegate──▶  h2 daemon  ──HTTP──▶  opencode serve  ──▶  GLM / Gemini / …
                                          ▲
                                          │ h2 tail / send / approve
                                          │
                                       you (tmux)
```

**Status:** v0.1 working prototype.

## Prerequisites

- [Deno 2.x](https://deno.com/) — `brew install deno` or see deno.com
- [opencode](https://opencode.ai/) — installed and authenticated (`opencode providers login`)

## Install

```bash
git clone https://github.com/AudienseCo/harness-squared.git
cd harness-squared
./scripts/install.sh    # compiles h2 → ~/.local/bin/h2
```

Make sure `~/.local/bin` is on your PATH.

## Setup (one-time)

**1. Configure your model** (optional — defaults to whatever opencode uses):

```bash
mkdir -p ~/.config/harness-squared
cat > ~/.config/harness-squared/config.toml << 'EOF'
[opencode]
model = "zai-coding-plan/glm-5.1"
EOF
```

**2. Tell Claude Code about h2:**

```bash
cat examples/claude_instructions.md >> ~/.claude/CLAUDE.md
```

Edit `~/.claude/CLAUDE.md` afterward — remove the preamble lines, keep the `## Delegating via harness²` section.

## Usage

**Three panes** (tmux, WezTerm splits, whatever):

### Pane 1: Start the daemon

```bash
h2 start
```

This launches the h2 daemon + an `opencode serve` child. Idempotent — run it again to check if it's up.

### Pane 2: Claude Code

```bash
claude    # or open Claude Code however you prefer
```

Ask Claude to do mechanical work. It will call `h2 delegate "..."` via Bash, then `h2 wait <id>` to block until done, then `h2 output <id>` to read the result. You approve Claude Code's Bash permission prompt as usual.

### Pane 3: Watch the delegation

```bash
h2 tail <job-id>    # job id shown in Claude's pane
```

You'll see tool calls stream past. When a permission prompt appears (e.g. "edit src/foo.ts"), press `y` to allow once, `a` to always allow, or `n` to reject.

Alternatively, open the opencode web UI at `http://127.0.0.1:<port>` (port is in `~/.harness-squared/pids.json`) or attach the opencode TUI:

```bash
opencode attach http://127.0.0.1:$(cat ~/.harness-squared/pids.json | grep opencodePort | grep -o '[0-9]*')
```

### When you're done

```bash
h2 stop
```

## CLI reference

| Command | What it does |
|---|---|
| `h2 start` | Start daemon + opencode (idempotent) |
| `h2 stop` | Shut everything down |
| `h2 delegate "<task>"` | Create a job, print its id |
| `h2 wait <id>` | Block until job finishes |
| `h2 output <id>` | Print session log (user msgs, tools, errors, result) |
| `h2 output <id> --full` | Verbose session log with tool inputs/outputs |
| `h2 status <id>` | Quick state check + pending permissions |
| `h2 tail <id>` | Live event stream with interactive permission prompts |
| `h2 send <id> "<msg>"` | Inject guidance mid-run, or resume an errored job |
| `h2 abort <id>` | Kill a running job |
| `h2 approve <id> <perm>` | Allow a pending permission (from any pane) |
| `h2 deny <id> <perm>` | Reject a pending permission |
| `h2 jobs` | List all jobs |

## How it works

1. `h2 delegate` creates an opencode session and fires a `prompt_async` with your task.
2. The daemon subscribes to opencode's SSE event stream and translates events (tool calls, permissions, completion) into h2's internal event model.
3. `h2 tail` and `h2 wait` subscribe to the daemon's per-job SSE stream over a unix socket.
4. Permission requests from opencode bubble up to whoever is tailing. Approvals flow back through the daemon to opencode.
5. When opencode fires `session.idle`, the daemon marks the job done and captures the final output.
6. `h2 output` fetches the full message history from opencode and renders a condensed conversation log.

## Tips

- **Use absolute paths** in task descriptions. The opencode session inherits the daemon's cwd, not Claude's.
- **If a job errors or hangs**, `h2 send <id> "continue"` resumes it. The subscription stays alive across errors.
- **Claude won't poll** — `h2 wait` blocks. If you see Claude polling `h2 status` in a loop, tell it to use `h2 wait` instead.
- **View the opencode TUI** for a richer view: `opencode attach http://127.0.0.1:<port>`.

## Configuration

`~/.config/harness-squared/config.toml` (all fields optional):

```toml
[opencode]
# model = "zai-coding-plan/glm-5.1"   # provider/model to use per-session
# bin = "opencode"                      # path to opencode binary
# args = []                             # extra args to opencode serve

[permissions]
# default = "wait"     # what happens when nobody is tailing: "wait", "deny", or "allow"
# timeout = 300        # seconds before auto-deny (only for default="deny")

[daemon]
# socket = "~/.harness-squared/daemon.sock"
```

## Design

See [DESIGN.md](./DESIGN.md) for the full spec, architecture, and open questions.
