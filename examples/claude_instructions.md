# Example CLAUDE.md addition for harness² (h2)

Drop this (or an edited version) into `~/.claude/CLAUDE.md` so Claude Code
knows when to reach for h2.

---

## Delegating via harness² (h2)

For implementation tasks that are well-scoped and mechanical — boilerplate,
tests, refactors, format conversions, repetitive edits across files — delegate
to the h2 daemon rather than writing the code yourself. Use the Bash tool:

- `h2 delegate "<task with exact paths and constraints>"` — returns a job id.
- `h2 status <id>` — check state (running/done/error) and pending permissions.
- `h2 output <id>` — fetch the final assistant text once state=done.
- `h2 abort <id>` — kill a job that's going off the rails.
- `h2 send <id> "<guidance>"` — inject a user message mid-run.

Between `delegate` and `status`, do something else useful or wait briefly
before polling. The user watches the job in another tmux pane with
`h2 tail <id>` and will approve permission prompts or steer as needed.

Write **specific** task descriptions: absolute paths, explicit constraints,
what NOT to change, what "done" looks like. Vague tasks produce vague diffs.

Do NOT delegate:

- Cross-file architectural decisions or API design
- Security-sensitive changes (auth, crypto, permissions, input validation)
- Tasks where the "right answer" is judgment-heavy rather than mechanical
- Anything destructive without user confirmation first
- Work that needs your own long-horizon planning

If a delegation errors or stalls (`h2 status` shows the same state for a long
time), read the error, decide whether to retry with an adjusted prompt,
abandon, or take the task back.
