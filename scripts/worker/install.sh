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
# --ssh-host NAME (the name the portal reaches this Mac by; default its tailnet name) --no-ssh (no portal ssh, w568)
# --voice-whisper MODEL|off (Whisper on this machine's GPU for the portal's mic, w615; a Mac has none: leave it off)
#
# Update an install that is there (w613, docs/worker-install.md "Updating"), also over ssh with no keychain:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --update --root DIR
# It asks nothing: every setting, the credential and the PATH come from the install. --max-sandboxes N,
# --max-agents-per-sandbox N, --max-unity N change those; --daemon-ref REF (default: the commit the portal runs).
set -euo pipefail

ROOT="" PORTAL="" MAXSB="" MAXAG="" MAXU="" SLOTS=8 SERVICE=com.fffactory.daemon SOURCE="" REF=main CREDFILE="" EXTRA="" REPO=https://github.com/Final-Factory/FinalFactory.git UPDATE=0 DREF=""
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
    --absolute-worktrees) EXTRA="$EXTRA --absolute-worktrees"; shift ;;
    --no-cleanup) EXTRA="$EXTRA --no-cleanup"; shift ;;
    --no-ssh) EXTRA="$EXTRA --no-ssh"; shift ;;
    --ssh-host) EXTRA="$EXTRA --ssh-host $2"; shift 2 ;;
    --voice-whisper) EXTRA="$EXTRA --voice-whisper $2"; VOICE=$2; shift 2 ;;
    --credential-file) CREDFILE=$2; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --daemon-ref) DREF=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

ask() { local a; read -r -p "$1${2:+ [$2]} " a </dev/tty; echo "${a:-$2}"; }
# A non-interactive ssh session's PATH may lack Homebrew and /usr/local (w629: m5's had no /opt/homebrew/bin, so its
# git-lfs was "missing"): put the ones that exist first, as a person's shell has them. This run's PATH only; the
# daemon's comes from the login shell (worker.ts withStandardPaths does the same for itself).
for d in /usr/local/bin /opt/homebrew/sbin /opt/homebrew/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$d:$PATH" ;; esac
done
export PATH
[ "$(id -u)" = 0 ] && { echo "Run this as yourself, not with sudo." >&2; exit 2; }

if [ "$UPDATE" = 1 ]; then
  # An update asks nothing (an ssh session has no terminal): the install that is there says everything else.
  [ -n "$ROOT" ] || { echo "--update needs --root DIR (the root of the install to update)." >&2; exit 2; }
  [ -f "$ROOT/root.json" ] || { echo "$ROOT holds no worker install (no root.json): install it first, without --update." >&2; exit 2; }
else
echo "FF Factory worker install. Everything this machine's worker uses goes in one folder (the root)."
[ -n "$ROOT" ] || ROOT=$(ask "Root folder (any empty or new folder with 200+ GB free, e.g. /Users/Shared/ffw)" "")
[ -n "$PORTAL" ] || PORTAL=$(ask "Portal URL" "https://")
[ -n "$MAXSB" ] || MAXSB=$(ask "Sandboxes at once" 3)
[ -n "$MAXAG" ] || MAXAG=$(ask "Agents per sandbox" 2)
[ -n "$MAXU" ] || MAXU=$(ask "Unity editors at once" 2)
if [ -n "$CREDFILE" ]; then CRED=$(head -n1 "$CREDFILE"); else read -r -s -p "Machine credential from the portal (ffm_..., hidden) " CRED </dev/tty; echo; fi
[ -n "$ROOT" ] && [ -n "$PORTAL" ] && [ -n "$CRED" ] || { echo "The root, the portal URL and the credential are all needed." >&2; exit 2; }
fi

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
  # ff-factory is public: no credential helper and no prompt, so a keychain out of reach over ssh is never asked (w613).
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.interactive=never clone --quiet --depth 1 --branch "$REF" https://github.com/Final-Factory/ff-factory.git "$TEMP/src" ||
    { echo "Could not download the installer (an anonymous git clone of ff-factory failed): check the network, or run it from a local ff-factory checkout with --source DIR." >&2; exit 2; }
  SOURCE="$TEMP/src"
fi
trap '[ -n "$TEMP" ] && rm -rf "$TEMP"' EXIT

FLAGS=(--disable-warning=ExperimentalWarning)
[ "$BEST" -ge 23006 ] || FLAGS=(--experimental-strip-types "${FLAGS[@]}")
if [ "$UPDATE" = 1 ]; then
  UARGS=(update --root "$ROOT")
  [ -z "$MAXSB" ] || UARGS+=(--max-sandboxes "$MAXSB")
  [ -z "$MAXAG" ] || UARGS+=(--max-agents-per-sandbox "$MAXAG")
  [ -z "$MAXU" ] || UARGS+=(--max-unity "$MAXU")
  [ -z "$DREF" ] || UARGS+=(--ref "$DREF")
  [ -z "${VOICE:-}" ] || UARGS+=(--voice-whisper "$VOICE")
  # A local checkout given with --source is the daemon code too: no download at all.
  [ -z "$SOURCE" ] || [ -n "$TEMP" ] || UARGS+=(--source "$SOURCE")
  "$NODE" "${FLAGS[@]}" "$SOURCE/scripts/worker/worker.ts" "${UARGS[@]}" </dev/null
  exit $?
fi
printf '%s\n' "$CRED" | "$NODE" "${FLAGS[@]}" "$SOURCE/scripts/worker/worker.ts" install --root "$ROOT" --portal-url "$PORTAL" \
  --max-sandboxes "$MAXSB" --max-agents-per-sandbox "$MAXAG" --max-unity "$MAXU" --slots "$SLOTS" --service "$SERVICE" --repo-url "$REPO" --credential-stdin $EXTRA
