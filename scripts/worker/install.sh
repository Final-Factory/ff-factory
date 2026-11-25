#!/bin/bash
# Install an FF Factory worker on this Mac or Linux PC, everything under one root folder (w513, docs/worker-install.md).
#
# Asks once for what it needs (the root folder, the portal's URL, this machine's credential, the limits), checks every
# prerequisite and changes nothing if one is missing, then: creates the root, clones the game repo into it, installs
# the daemon as a LaunchAgent (a systemd user service on Linux) with its folders in the root and waits for the portal to see the machine. Safe to run
# again. One command, from anywhere:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)"
# or from a clone of ff-factory: bash scripts/worker/install.sh
#
# Options (each is asked for when missing): --root DIR --portal-url URL --max-sandboxes N --max-agents-per-sandbox N
# --max-unity N --slots N --service LABEL --source CHECKOUT --ref BRANCH|COMMIT --credential-file FILE (unattended tests)
# --ssh-host NAME (the name the portal reaches this machine by; default its tailnet name) --no-ssh (no portal ssh, w568)
# --voice-whisper MODEL|off (Whisper on this machine's GPU for the portal's mic, w615; a Mac has none: leave it off)
#
# Update an install that is there (w613, docs/worker-install.md "Updating"), also over ssh with no keychain:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --update --root DIR
# It asks nothing: every setting, the credential and the PATH come from the install. --max-sandboxes N,
# --max-agents-per-sandbox N, --max-unity N change those; --worker-fence on|off sets the worker write fence (w5377);
# --worker-caps off|warn|enforce sets the worker memory, process and temp caps' mode (w5554);
# --transcript-lock on|off (Linux, w5702) lets each locked worker write only its own conversation's transcript;
# --store-lock off|warn|on (w5614) makes the main clone read-only to fenced workers once every sandbox is a slot repo;
# --daemon-ref REF (default: the pinned --ref, else the commit the portal runs).
# --ref <full commit id> (w5516) pins the installer and the daemon code to that exact commit and refuses when it cannot check
# it out; the portal's rollout fetches this script at its own verified commit and passes it:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/<commit>/scripts/worker/install.sh)" -- --update --ref <commit> --root DIR
# --tools instead of --update publishes the latest agent tools (final-factory-agents' plugins) for Claude Code here and
# changes nothing else (w1476, docs/worker-install.md "The agent tools"); the portal runs it after every verified deploy.
set -euo pipefail

ROOT="" PORTAL="" MAXSB="" MAXAG="" MAXU="" SLOTS=8 SERVICE="" INSTANCE="" SOURCE="" REF=main CREDFILE="" EXTRA="" REPO=https://github.com/Final-Factory/FinalFactory.git UPDATE=0 TOOLS=0 DREF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --portal-url) PORTAL=$2; shift 2 ;;
    --max-sandboxes) MAXSB=$2; shift 2 ;;
    --max-agents-per-sandbox) MAXAG=$2; shift 2 ;;
    --max-unity) MAXU=$2; shift 2 ;;
    --slots) SLOTS=$2; shift 2 ;;
    --service) SERVICE=$2; shift 2 ;;
    --instance) INSTANCE=$2; EXTRA="$EXTRA --instance $2"; shift 2 ;;
    --claude-config-dir) EXTRA="$EXTRA --claude-config-dir $2"; shift 2 ;;
    --unity-slots-dir) EXTRA="$EXTRA --unity-slots-dir $2"; shift 2 ;;
    --firewall-suffix) EXTRA="$EXTRA --firewall-suffix $2"; shift 2 ;;
    --source) SOURCE=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --repo-url) REPO=$2; shift 2 ;;
    --absolute-worktrees) EXTRA="$EXTRA --absolute-worktrees"; shift ;;
    --no-cleanup) EXTRA="$EXTRA --no-cleanup"; shift ;;
    --no-ssh) EXTRA="$EXTRA --no-ssh"; shift ;;
    --ssh-host) EXTRA="$EXTRA --ssh-host $2"; shift 2 ;;
    --voice-whisper) EXTRA="$EXTRA --voice-whisper $2"; VOICE=$2; shift 2 ;;
    --worker-fence) case "${2:-}" in on|off) WFENCE=$2 ;; *) echo "--worker-fence is on or off, not \"${2:-}\"" >&2; exit 2 ;; esac; shift 2 ;;
    --worker-caps) case "${2:-}" in off|warn|enforce) WCAPS=$2 ;; *) echo "--worker-caps is off, warn or enforce, not \"${2:-}\"" >&2; exit 2 ;; esac; shift 2 ;;
    --transcript-lock) case "${2:-}" in on|off) TLOCK=$2 ;; *) echo "--transcript-lock is on or off, not \"${2:-}\"" >&2; exit 2 ;; esac; shift 2 ;;
    --store-lock) case "${2:-}" in off|warn|on) SLOCK=$2 ;; *) echo "--store-lock is off, warn or on, not \"${2:-}\"" >&2; exit 2 ;; esac; shift 2 ;;
    --credential-file) CREDFILE=$2; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --tools) TOOLS=1; shift ;;
    --daemon-ref) DREF=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

ask() { local a; read -r -p "$1${2:+ [$2]} " a </dev/tty; echo "${a:-$2}"; }
# A non-interactive ssh session's PATH may lack Homebrew and /usr/local (w629: m5's had no /opt/homebrew/bin, so its
# git-lfs was "missing"): put the ones that exist first, as a person's shell has them. This run's PATH only; the
# daemon's comes from the login shell (worker.ts withStandardPaths does the same for itself).
# On Linux, node from nodejs.org unpacked in ~/.local/node (Ubuntu's own nodejs package runs no TypeScript).
for d in /usr/local/bin /opt/homebrew/sbin /opt/homebrew/bin "$HOME/.local/node/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$d:$PATH" ;; esac
done
LINUX=0; [ "$(uname -s)" = Linux ] && LINUX=1
export PATH
[ "$(id -u)" = 0 ] && { echo "Run this as yourself, not with sudo." >&2; exit 2; }

if [ "$UPDATE" = 1 ] || [ "$TOOLS" = 1 ]; then
  # An update asks nothing (an ssh session has no terminal): the install that is there says everything else.
  [ -n "$ROOT" ] || { echo "--update and --tools need --root DIR (the root of the install to update)." >&2; exit 2; }
  [ -f "$ROOT/root.json" ] || { echo "$ROOT holds no worker install (no root.json): install it first, without --update or --tools." >&2; exit 2; }
else
echo "FF Factory worker install. Everything this machine's worker uses goes in one folder (the root)."
[ -n "$ROOT" ] || ROOT=$(ask "Root folder (any empty or new folder with 200+ GB free, e.g. $([ "$LINUX" = 1 ] && echo "$HOME/ffw" || echo /Users/Shared/ffw))" "")
[ -n "$PORTAL" ] || PORTAL=$(ask "Portal URL" "https://")
[ -n "$MAXSB" ] || MAXSB=$(ask "Sandboxes at once" 3)
[ -n "$MAXAG" ] || MAXAG=$(ask "Agents per sandbox" 2)
[ -n "$MAXU" ] || MAXU=$(ask "Unity editors at once" 2)
if [ -n "$CREDFILE" ]; then CRED=$(head -n1 "$CREDFILE"); else read -r -s -p "Machine credential from the portal (ffm_..., hidden) " CRED </dev/tty; echo; fi
[ -n "$ROOT" ] && [ -n "$PORTAL" ] && [ -n "$CRED" ] || { echo "The root, the portal URL and the credential are all needed." >&2; exit 2; }
fi

# The tools this script itself needs: node 22.6+ that runs TypeScript, and git 2.48+ (the rest is checked by worker.ts).
NODE="" ; BEST=0
TSCHECK=$(mktemp -d); printf 'const a: number = 1;\n' >"$TSCHECK/t.ts"
for n in $(command -v -a node 2>/dev/null) /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.local/node/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
  # Ubuntu's nodejs is built without TypeScript (ERR_NO_TYPESCRIPT): a node that cannot run the daemon does not count.
  "$n" --experimental-strip-types --disable-warning=ExperimentalWarning "$TSCHECK/t.ts" >/dev/null 2>&1 || continue
  num=$(echo "$v" | awk -F. '{printf "%d%03d", $1, $2}')
  if [ "$num" -gt "$BEST" ]; then NODE=$n; BEST=$num; fi
done
rm -rf "$TSCHECK"
offer() { echo "$1 is needed. Install it with: $2   then run this installer again." >&2; exit 2; }
if [ "$LINUX" = 1 ]; then
  [ "$BEST" -ge 22006 ] || offer "Node.js 22.6 or newer that runs TypeScript (Ubuntu's nodejs package does not)" "the Linux x64 build from https://nodejs.org unpacked into ~/.local/node"
  GITV=$(git --version 2>/dev/null | awk '{print $3}' | awk -F. '{printf "%d%03d", $1, $2}')
  [ "${GITV:-0}" -ge 2048 ] || offer "git 2.48 or newer (found: $(git --version 2>/dev/null || echo none))" "sudo apt install git (older Ubuntus: sudo add-apt-repository ppa:git-core/ppa first)"
else
[ "$BEST" -ge 22006 ] || offer "Node.js 22.6 or newer" "brew install node"
GITV=$(git --version 2>/dev/null | awk '{print $3}' | awk -F. '{printf "%d%03d", $1, $2}')
[ "${GITV:-0}" -ge 2048 ] || offer "git 2.48 or newer (found: $(git --version 2>/dev/null || echo none))" "brew install git"
fi

# --ref is a branch, or a full commit id (w5516: what the portal's rollout and its join scripts pass, the commit it verified
# and runs); a commit is checked out exactly or the installer refuses. A short id names nothing for certain: refused.
PINNED=0
if [[ $REF =~ ^[0-9a-fA-F]{40}$ ]]; then PINNED=1; REF=$(printf '%s' "$REF" | tr 'A-F' 'a-f')
elif [[ $REF =~ ^[0-9a-fA-F]{7,39}$ ]]; then echo "--ref $REF looks like a short commit id: pass the full 40-character id (or a branch name). Nothing was changed." >&2; exit 2; fi

TEMP=""
if [ -z "$SOURCE" ]; then
  HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
  if [ -n "$HERE" ] && [ -f "$HERE/../../machine/daemon.ts" ]; then SOURCE=$(cd "$HERE/../.." && pwd); fi
fi
if [ -z "$SOURCE" ]; then
  # A template with X's: GNU mktemp (Linux) refuses -t without them.
  TEMP=$(mktemp -d "${TMPDIR:-/tmp}/ff-worker-src.XXXXXX")
  # ff-factory is public: no credential helper and no prompt, so a keychain out of reach over ssh is never asked (w613).
  if [ "$PINNED" = 1 ]; then
    # A commit (w5516): exactly that commit, fetched by its id, or nothing.
    { git init --quiet "$TEMP/src" &&
      GIT_TERMINAL_PROMPT=0 git -C "$TEMP/src" -c credential.helper= -c credential.interactive=never fetch --quiet --depth 1 --no-tags https://github.com/Final-Factory/ff-factory.git "$REF" &&
      git -C "$TEMP/src" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD; } ||
      { rm -rf "$TEMP"; echo "Could not download ff-factory at commit $REF (an anonymous git fetch of that commit failed): nothing was changed." >&2; exit 2; }
  else
    GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.interactive=never clone --quiet --depth 1 --branch "$REF" https://github.com/Final-Factory/ff-factory.git "$TEMP/src" ||
      { rm -rf "$TEMP"; echo "Could not download the installer (an anonymous git clone of ff-factory failed): check the network, or run it from a local ff-factory checkout with --source DIR." >&2; exit 2; }
  fi
  SOURCE="$TEMP/src"
fi
trap '[ -n "$TEMP" ] && rm -rf "$TEMP"' EXIT
if [ "$PINNED" = 1 ]; then
  # The code that runs must be the commit asked for, to the id, wherever it came from; else nothing is changed.
  HEADC=$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null | tr 'A-F' 'a-f' || true)
  [ "$HEADC" = "$REF" ] || { echo "--ref $REF, but the installer's checkout ($SOURCE) is at ${HEADC:-no commit git can read}: refusing, nothing was changed." >&2; exit 2; }
  echo "The installer and the daemon code: ff-factory $REF (pinned, --ref)."
  # The daemon code is that commit too, unless --daemon-ref names another (a rollback).
  [ -n "$DREF" ] || DREF=$REF
fi

FLAGS=(--disable-warning=ExperimentalWarning)
[ "$BEST" -ge 23006 ] || FLAGS=(--experimental-strip-types "${FLAGS[@]}")
if [ "$TOOLS" = 1 ]; then
  # The latest agent tools (final-factory-agents' plugins) for Claude Code on this machine (w1476): stops nothing.
  "$NODE" "${FLAGS[@]}" "$SOURCE/scripts/worker/worker.ts" tools --root "$ROOT" </dev/null
  exit $?
fi
if [ "$UPDATE" = 1 ]; then
  UARGS=(update --root "$ROOT")
  [ -z "$MAXSB" ] || UARGS+=(--max-sandboxes "$MAXSB")
  [ -z "$MAXAG" ] || UARGS+=(--max-agents-per-sandbox "$MAXAG")
  [ -z "$MAXU" ] || UARGS+=(--max-unity "$MAXU")
  [ -z "$DREF" ] || UARGS+=(--ref "$DREF")
  [ -z "${VOICE:-}" ] || UARGS+=(--voice-whisper "$VOICE")
  [ -z "${WFENCE:-}" ] || UARGS+=(--worker-fence "$WFENCE")
  [ -z "${WCAPS:-}" ] || UARGS+=(--worker-caps "$WCAPS")
  [ -z "${TLOCK:-}" ] || UARGS+=(--transcript-lock "$TLOCK")
  [ -z "${SLOCK:-}" ] || UARGS+=(--store-lock "$SLOCK")
  # A local checkout given with --source is the daemon code too: no download at all.
  [ -z "$SOURCE" ] || [ -n "$TEMP" ] || UARGS+=(--source "$SOURCE")
  "$NODE" "${FLAGS[@]}" "$SOURCE/scripts/worker/worker.ts" "${UARGS[@]}" </dev/null
  exit $?
fi
# --instance (w14, docs/instances.md): a second instance's daemon names its own LaunchAgent unless --service does.
SVC=()
if [ -n "$SERVICE" ]; then SVC=(--service "$SERVICE"); elif [ -z "$INSTANCE" ]; then SVC=(--service com.fffactory.daemon); fi
printf '%s\n' "$CRED" | "$NODE" "${FLAGS[@]}" "$SOURCE/scripts/worker/worker.ts" install --root "$ROOT" --portal-url "$PORTAL" \
  --max-sandboxes "$MAXSB" --max-agents-per-sandbox "$MAXAG" --max-unity "$MAXU" --slots "$SLOTS" ${SVC[@]+"${SVC[@]}"} --repo-url "$REPO" --credential-stdin $EXTRA
