#!/bin/bash
# Move this Mac's FF Factory daemon from today's layout into one worker root (w513, docs/worker-install.md,
# "Migrating"). --dry-run shows what would move where and the space the copies need, and changes nothing; --rollback
# undoes a migration until --cleanup, which deletes the old layout (--legacy: also archives ~/ff-worker).
#   bash scripts/worker/migrate.sh --root /Users/Shared/ffw [--from DIR] [--old-slots DIR] [--nightly DIR] [--dry-run]
set -euo pipefail
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root|--from|--from-service|--old-slots|--nightly|--portal-url|--slots|--service|--repo-url|--max-sandboxes|--max-agents-per-sandbox|--max-unity) ARGS+=("$1" "$2"); shift 2 ;;
    --dry-run|--rollback|--cleanup|--legacy|--no-cleanup|--absolute-worktrees) ARGS+=("$1"); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] && { echo "Run this as yourself, not with sudo." >&2; exit 2; }
NODE="" ; BEST=0
for n in $(command -v -a node 2>/dev/null) /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
  num=$(echo "$v" | awk -F. '{printf "%d%03d", $1, $2}')
  if [ "$num" -gt "$BEST" ]; then NODE=$n; BEST=$num; fi
done
[ "$BEST" -ge 22006 ] || { echo "Node.js 22.6 or newer is needed (brew install node)." >&2; exit 2; }
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FLAGS=(--disable-warning=ExperimentalWarning)
[ "$BEST" -ge 23006 ] || FLAGS=(--experimental-strip-types "${FLAGS[@]}")
"$NODE" "${FLAGS[@]}" "$SRC/scripts/worker/worker.ts" migrate "${ARGS[@]}"
