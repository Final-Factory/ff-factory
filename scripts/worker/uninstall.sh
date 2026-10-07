#!/bin/bash
# Remove an FF Factory worker install from this Mac or Linux PC (w513, docs/worker-install.md). Refuses, naming them, while agents
# are mid-turn there or its sandboxes hold unpushed commits or uncommitted files (--force discards them). Then: the
# portal forgets the machine, the LaunchAgent (the systemd user service) goes, whatever still runs from the root is stopped, the root is deleted,
# and a check lists anything left.
#   bash <root>/daemon/src/scripts/worker/uninstall.sh --root <root> [--yes] [--force] [--keep-registration]
set -euo pipefail
ROOT="" ; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --yes|--force|--keep-registration) EXTRA+=("$1"); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$ROOT" ] || { echo "usage: uninstall.sh --root <root> [--yes] [--force] [--keep-registration]" >&2; exit 2; }
NODE="" ; BEST=0
TSCHECK=$(mktemp -d); printf 'const a: number = 1;\n' >"$TSCHECK/t.ts"
for n in $(command -v -a node 2>/dev/null) /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.local/node/bin/node; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
  "$n" --experimental-strip-types --disable-warning=ExperimentalWarning "$TSCHECK/t.ts" >/dev/null 2>&1 || continue
  num=$(echo "$v" | awk -F. '{printf "%d%03d", $1, $2}')
  if [ "$num" -gt "$BEST" ]; then NODE=$n; BEST=$num; fi
done
rm -rf "$TSCHECK"
[ "$BEST" -ge 22006 ] || { echo "Node.js 22.6 or newer that runs TypeScript is needed (brew install node; on Linux nodejs.org's build in ~/.local/node)." >&2; exit 2; }
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[ -f "$SRC/scripts/worker/worker.ts" ] || SRC="$ROOT/daemon/src"
# The code may live inside the root it deletes: run a copy from the temp folder.
COPY=$(mktemp -d "${TMPDIR:-/tmp}/ff-worker-uninstall.XXXXXX")
trap 'rm -rf "$COPY"' EXIT
cp -R "$SRC/scripts" "$SRC/server" "$SRC/shared" "$SRC/machine" "$SRC/package.json" "$COPY/"
FLAGS=(--disable-warning=ExperimentalWarning)
[ "$BEST" -ge 23006 ] || FLAGS=(--experimental-strip-types "${FLAGS[@]}")
cd "$COPY"
"$NODE" "${FLAGS[@]}" "$COPY/scripts/worker/worker.ts" uninstall --root "$ROOT" ${EXTRA[@]+"${EXTRA[@]}"}
