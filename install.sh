#!/usr/bin/env bash
# Jarvis installer (Linux / macOS / WSL / git-bash)
#   curl -fsSL https://raw.githubusercontent.com/Mhdi-M/jarvis-orb/main/install.sh | bash
#   or:  JARVIS_DIR=~/src/jarvis ./install.sh
set -euo pipefail

DIR="${JARVIS_DIR:-$HOME/.local/share/jarvis}"
REPO="${JARVIS_REPO:-https://github.com/Mhdi-M/jarvis-orb.git}"
BIN="${JARVIS_BIN:-$HOME/.local/bin}"
say() { printf '  %s\n' "$*"; }
fail() { printf '  x %s\n' "$*" >&2; exit 1; }

echo
echo "Jarvis installer"
echo

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required (https://nodejs.org, or your package manager)"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node 20+ required (found $(node -v))"
command -v git >/dev/null 2>&1 || fail "git is required"

# --- repo --------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" pull --ff-only >/dev/null 2>&1 || say "pull skipped (local changes)"
else
  say "cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 || fail "git clone failed"
fi
[ -f "$DIR/cli/jarvis.js" ] || fail "install incomplete: cli/jarvis.js missing"

# --- hermes ------------------------------------------------------------------
if ! command -v hermes >/dev/null 2>&1 && [ "${JARVIS_NO_HERMES:-0}" != "1" ]; then
  say "installing Hermes (the agent brain Jarvis drives)..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash >/dev/null 2>&1 || \
      say "Hermes install failed — Jarvis still works with local Ollama; retry later"
  else
    say "curl missing; install Hermes from https://hermes-agent.nousresearch.com"
  fi
elif command -v hermes >/dev/null 2>&1; then
  say "hermes found: $(command -v hermes)"
fi

# --- shim --------------------------------------------------------------------
mkdir -p "$BIN"
cat > "$BIN/jarvis" <<SHIM
#!/usr/bin/env bash
exec node "$DIR/cli/jarvis.js" "\$@"
SHIM
chmod +x "$BIN/jarvis"
say "command installed: $BIN/jarvis"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "add this to your shell profile:  export PATH=\"$BIN:\$PATH\"" ;;
esac

# --- setup -------------------------------------------------------------------
PROBE=""
[ "${JARVIS_NO_PROBE:-0}" = "1" ] && PROBE="--no-probe"
say "probing this machine's models..."
node "$DIR/cli/jarvis.js" --setup $PROBE

echo
echo "Done. Type:  jarvis"
echo "Then:        /models   /perf   /security   /help"
echo
