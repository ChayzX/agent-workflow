#!/usr/bin/env bash
# Guided installer for Debian/Ubuntu (also works on other Linux with Node >= 22.13 and git).
# Safe by default: asks before installing packages, never uses sudo without consent, never
# overwrites an existing configuration. Non-interactive: ORCH_YES=1 ./deploy/install.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
yes="${ORCH_YES:-0}"
say() { printf '\n==> %s\n' "$*"; }
ask() { [ "$yes" = 1 ] && return 0; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }
need_sudo() { if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null; then sudo "$@"; else echo "need root for: $*"; return 1; fi; }

say "Checking operating system"
. /etc/os-release 2>/dev/null || true
echo "  ${PRETTY_NAME:-unknown Linux} ($(uname -m))"
[ "$(uname -s)" = Linux ] || { echo "Linux is required for the self-hosted service"; exit 1; }

say "Checking dependencies"
missing=()
for b in git tar; do command -v "$b" >/dev/null || missing+=("$b"); done
command -v bwrap >/dev/null || missing+=(bubblewrap)
if [ ${#missing[@]} -gt 0 ]; then
  echo "  missing: ${missing[*]}"
  if command -v apt-get >/dev/null && ask "Install ${missing[*]} with apt-get (requires sudo)?"; then
    need_sudo apt-get update -qq && need_sudo apt-get install -y -qq "${missing[@]}"
  else echo "  continuing without: ${missing[*]} (bubblewrap is optional but recommended)"; fi
fi
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  echo "  Node.js >= 22.13 is required (found: $(node --version 2>/dev/null || echo none))."
  if command -v apt-get >/dev/null && ask "Install Node.js 22 from NodeSource (requires sudo; adds an apt repository)?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh && need_sudo bash /tmp/nodesource_setup.sh && need_sudo apt-get install -y -qq nodejs
  else echo "  Install Node 22 (e.g. https://nodejs.org or nvm) and re-run."; exit 1; fi
fi
echo "  node $(node --version), git $(git --version | cut -d' ' -f3)"

say "Building (only if dist/ is missing — release ZIPs ship prebuilt)"
if [ ! -f "$here/dist/src/cli/main.js" ]; then (cd "$here" && npm ci --no-audit --no-fund && npm run build); fi

say "Linking the CLI into ~/.local/bin"
mkdir -p "$HOME/.local/bin"
ln -sf "$here/bin/orchestrator" "$HOME/.local/bin/orchestrator"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac

say "Provider CLIs (official tools; authentication stays inside them)"
for p in claude codex; do
  if command -v "$p" >/dev/null; then echo "  $p: $($p --version 2>/dev/null | head -1)";
  else
    pkg=$([ "$p" = claude ] && echo @anthropic-ai/claude-code || echo @openai/codex)
    if ask "Install $p CLI globally with npm ($pkg)?"; then npm install -g "$pkg"; else echo "  skipped $p"; fi
  fi
done

say "Configuration"
svc=""; ask "Install and start a systemd user service?" && svc="--service"
"$here/bin/orchestrator" setup $svc

cat <<MSG

Next steps:
  1. Authenticate providers on this server (once):
       claude login            # or: claude setup-token   (Claude Pro/Max subscription)
       codex login --device-auth                           (ChatGPT plan)
  2. (GitHub mode) save a token:  install -m 600 /dev/null ~/.orchestrator/secrets/github-token && \$EDITOR ~/.orchestrator/secrets/github-token
  3. orchestrator doctor
  4. orchestrator start --goal examples/goals/todo-cli.md --repo new
  5. orchestrator status    |  dashboard: http://127.0.0.1:7420/
MSG
