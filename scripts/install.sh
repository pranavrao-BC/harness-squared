#!/usr/bin/env bash
# Build a single `h2` binary and drop it in ~/.local/bin.
#
# Prereqs: deno 2.x on PATH, opencode on PATH (the binary will still need to
# find the source tree at runtime for the daemon unless you also embed it —
# for dev we just keep the source tree around and point h2 at it via
# H2_DAEMON_CMD if you move the binary.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

command -v deno >/dev/null 2>&1 || { echo "deno not found on PATH" >&2; exit 1; }
command -v opencode >/dev/null 2>&1 || { echo "opencode not found on PATH" >&2; exit 1; }

mkdir -p "$HOME/.local/bin" "$REPO_ROOT/dist"

echo "Compiling h2..."
deno task compile

echo "Installing to $HOME/.local/bin/h2"
cp "$REPO_ROOT/dist/h2" "$HOME/.local/bin/h2"

cat <<EOF

Installed. Make sure \$HOME/.local/bin is on your PATH.

Quick start:
  h2 start
  h2 delegate "add a license header to /tmp/foo.ts"
  # in another pane:
  h2 tail <job-id>

Config:     ~/.config/harness-squared/config.toml  (optional)
Socket:     ~/.harness-squared/daemon.sock
Log:        ~/.harness-squared/daemon.log

If you move the compiled binary away from this repo, the daemon entry won't
resolve. Either keep this repo in place, or set H2_DAEMON_CMD to an explicit
command (e.g. "deno run --allow-all /path/to/src/daemon/main.ts").
EOF
