#!/bin/bash
# Install an FF Factory worker on this Mac, everything under one root folder (w513, docs/worker-install.md).
#
# Asks once for what it needs (the root folder, the portal's URL, this machine's credential, the limits), checks every
# prerequisite and changes nothing if one is missing, then: creates the root, clones the game repo into it, installs
# the daemon as a LaunchAgent with its folders in the root and waits for the portal to see the machine. Safe to run
# again. One command, from anywhere:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)"
# or from a clone of ff-factory: bash scripts/worker/install.sh
#
# Options (each is asked for when missing): --root DIR --portal-url URL --max-sandboxes N --max-agents-per-sandbox N
# --max-unity N --slots N --service LABEL --source CHECKOUT --ref BRANCH --credential-file FILE (unattended tests)
set -euo pipefail

ROOT="" PORTAL="" MAXSB="" MAXAG="" MAXU="" SLOTS=8 SERVICE=com.fffactory.daemon SOURCE="" REF=main CREDFILE="" REPO=https://github.com/Final-Factory/FinalFactory.git
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --portal-url) PORTAL=$2; shift 2 ;;
    --max-sandboxes) MAXSB=$2; shift 2 ;;
    --max-agents-per-sandbox) MAXAG=$2; shift 2 ;;
    --max-unity) MAXU=$2; shift 2 ;;
    --slots) SLOTS=$2; shift 2 ;;
    --service) SERVICE=$2; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --repo-url) REPO=$2; shift 2 ;;
    --credential-file) CREDFILE=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

ask() { local a; read -r -p "$1${2:+ [$2]} " a </dev/tty; echo "${a:-$2}"; }
[ "$(id -u)" = 0 ] && { echo "Run this as yourself, not with sudo." >&2; exit 2; }

echo "FF Factory worker install. Everything this machine's worker uses goes in one folder (the root)."
[ -n "$ROOT" ] || ROOT=$(ask "Root folder (any empty or new folder with 200+ GB free, e.g. /Users/Shared/ffw)" "")
[ -n "$PORTAL" ] || PORTAL=$(ask "Portal URL" "https://")
[ -n "$MAXSB" ] || MAXSB=$(ask "Sandboxes at once" 3)
[ -n "$MAXAG" ] || MAXAG=$(ask "Agents per sandbox" 2)
[ -n "$MAXU" ] || MAXU=$(ask "Unity editors at once" 2)
if [ -n "$CREDFILE" ]; then CRED=$(head -n1 "$CREDFILE"); else read -r -s -p "Machine credential from the portal (ffm_..., hidden) " CRED </dev/tty; echo; fi
[ -n "$ROOT" ] && [ -n "$PORTAL" ] && [ -n "$CRED" ] || { echo "The root, the portal URL and the credential are all needed." >&2; exit 2; }

# The tools this script itself needs: node 22.6+ and git 2.48+ (the rest is checked by worker.ts).
NODE="" ; BEST=0
for n in $(command -v -a node 2>/dev/null) /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
  num=$(echo "$v" | awk -F. '{printf "%d%03d", $1, $2}')
  if [ "$num" -gt "$BEST" ]; then NODE=$n; BEST=$num; fi
done
offer() { echo "$1 is needed. Install it with: $2   then run this installer again." >&2; exit 2; }
[ "$BEST" -ge 22006 ] || offer "Node.js 22.6 or newer" "brew install node"
GITV=$(git --version 2>/dev/null | awk '{print $3}' | awk -F. '{printf "%d%03d", $1, $2}')
[ "${GITV:-0}" -ge 2048 ] || offer "git 2.48 or newer (found: $(git --version 2>/dev/null || echo none))" "brew install git"

TEMP=""
if [ -z "$SOURCE" ]; then
  HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
  if [ -n "$HERE" ] && [ -f "$HERE/../../machine/daemon.ts" ]; then SOURCE=$(cd "$HERE/../.." && pwd); fi
fi
if [ -z "$SOURCE" ]; then
  TEMP=$(mktemp -d -t ff-worker-src)
  git clone --quiet --depth 1 --branch "$REF" https://github.com/Final-Factory/ff-factory.git "$TEMP/src"
  SOURCE="$TEMP/src"
fi
trap '[ -n "$TEMP" ] && rm -rf "$TEMP"' EXIT

FLAGS=(--disable-warning=ExperimentalWarning)
[ "$BEST" -ge 23006 ] || FLAGS=(--experimental-strip-types "${FLAGS[@]}")
printf '%s\n' "$CRED" | "$NODE" "${FLAGS[@]}" "$SOURCE/scripts/worker/worker.ts" install --root "$ROOT" --portal-url "$PORTAL" \
  --max-sandboxes "$MAXSB" --max-agents-per-sandbox "$MAXAG" --max-unity "$MAXU" --slots "$SLOTS" --service "$SERVICE" --repo-url "$REPO" --credential-stdin
