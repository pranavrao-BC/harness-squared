# harness²

A harness for harnesses. Claude Code drives opencode via a small Deno daemon,
so Opus can plan and delegate mechanical work to cheaper executors (GLM,
Gemini Flash) while the user observes and gates permissions.

**Status:** v0.1 exploratory prototype. See [DESIGN.md](./DESIGN.md) for the
full spec and [§14](./DESIGN.md#14-success-criteria-for-v01) for what "working"
means.

## The idea

```
Claude Code (Opus)  ──h2 delegate──▶  h2 daemon  ──HTTP──▶  opencode serve  ──▶  GLM / Gemini / …
                                          ▲
                                          │ h2 tail / send / approve
                                          │
                                       you (tmux)
```

- Claude Code (supervisor) calls `h2 delegate "..."` via its `Bash` tool.
- The daemon owns an `opencode serve` child and routes tasks as opencode sessions.
- You watch and guide via `h2 tail <id>` in another tmux pane.
- Permission prompts from opencode bubble up to your tail pane for approval.

## Quick start

Install prereqs:

- [Deno 2.x](https://deno.com/) on `PATH`
- [opencode](https://opencode.ai/) authenticated for at least one provider
  (`opencode providers login`)

Run from source (no install step):

```bash
deno task cli start                 # launch daemon + opencode serve
deno task cli delegate "add '// Copyright 2026' as the first line of /tmp/foo.ts"
deno task cli tail <job-id>         # in another pane: watch events, approve perms
deno task cli output <job-id>       # once state=done
deno task cli stop
```

Or compile and install `h2` into `~/.local/bin`:

```bash
./scripts/install.sh
h2 start
h2 delegate "..."
```

## Configuration

Optional: `~/.config/harness-squared/config.toml`.

```toml
[opencode]
model = "zai-coding-plan/glm-5.1"

[permissions]
default = "wait"
```

See [DESIGN.md §10](./DESIGN.md#10-config) for all options.

## Claude-side hookup

The daemon is invoked by Claude Code through the normal `Bash` tool, gated by
Claude's usual permission prompt. A suggested CLAUDE.md snippet lives in
[examples/claude_instructions.md](./examples/claude_instructions.md) — read it,
edit it for your workflow, paste it into `~/.claude/CLAUDE.md`.

## Layout

```
src/
  cli/         # `h2` CLI — thin, all commands talk to the daemon over a unix socket
  daemon/      # `h2 daemon` — owns opencode serve, jobs, permissions, event fan-out
  shared/      # types, paths, logging, SSE parser
```

Entry points: `src/cli/main.ts`, `src/daemon/main.ts`.

## Non-goals (v0.1)

No cost tracking, no parallel jobs, no executor profiles, no persistence, no
TUI, no auth. See [DESIGN.md §2](./DESIGN.md#2-non-goals-for-this-exploration).

## Known gaps

- Sessions inherit the daemon's cwd; there's no per-delegation working
  directory override yet. Put absolute paths in your task text for now.
- No graceful daemon restart — if the daemon dies, in-flight jobs are lost.
- `h2 tail` uses a blocking `stdin.read` for the permission prompt, so it
  only handles one prompt at a time. That's fine for exploratory use.
