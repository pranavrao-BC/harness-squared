#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$HOME/.config/harness-squared"
CONFIG_FILE="$CONFIG_DIR/config.toml"
BIN_DIR="$HOME/.local/bin"
INSTALL_PATH="$BIN_DIR/h2"

# --- Prerequisites ---

if ! command -v deno >/dev/null 2>&1; then
  echo "error: deno not found on PATH. Install deno 2.x first: https://deno.land" >&2
  exit 1
fi

DENO_VERSION="$(deno --version 2>/dev/null | head -1)"
case "$DENO_VERSION" in
  deno\ 2.*|deno\ [3-9].*) ;;
  *) echo "error: deno 2.x required, got: $DENO_VERSION" >&2; exit 1 ;;
esac

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: opencode not found on PATH" >&2
  exit 1
fi

if ! command -v gemini >/dev/null 2>&1; then
  echo "note: gemini CLI not found. Gemini executor will be unavailable until you install it."
fi

# --- Compile ---

cd "$REPO_ROOT"
mkdir -p "$BIN_DIR" "$REPO_ROOT/dist"

echo "Compiling h2..."
deno task compile

echo "Installing to $INSTALL_PATH"
cp "$REPO_ROOT/dist/h2" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"

# --- Default config ---

mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG_FILE" ]; then
  echo "Config already exists at $CONFIG_FILE (not overwriting)"
else
  cat > "$CONFIG_FILE" <<'CONF'
executor = "opencode"

[opencode]
model = "zai-coding-plan/glm-5.1"

[permissions]
default = "wait"
CONF
  echo "Created default config at $CONFIG_FILE"
fi

# --- PATH check ---

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "warning: $BIN_DIR is not on your PATH."
    echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
esac

# --- Summary ---

cat <<EOF

Done. harness² (h2) is installed.

  Binary:  $INSTALL_PATH
  Config:  $CONFIG_FILE
  Socket:  ~/.harness-squared/daemon.sock
  Log:     ~/.harness-squared/daemon.log

Three-pane setup:
  Pane 1:  h2 start
  Pane 2:  claude          (then ask it to delegate tasks via h2)
  Pane 3:  h2 tail <job-id>

Quick test:
  h2 start && h2 exec 'console.log(await h2.run("say ok"))'
EOF
