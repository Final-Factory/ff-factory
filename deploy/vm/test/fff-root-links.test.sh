#!/usr/bin/env bash
# Root in fff's folders (w5531), against a fixture /srv/fff: run by lint.sh --units (root; skipped otherwise). fff owns its
# data folder and can put a symbolic link in place of it, or of anything in it, in the sticky $FFF_ROOT; root's helpers in
# lib.sh (tell_dispatcher, data_write, fff_dir, fff_write) must then refuse and log, and change nothing the link points at.
# What it checks:
#   a normal tell_dispatcher and data_write leave fff's file, 0600, in fff's 0700 folder;
#   an inbox, a data folder or a data file that is a link to a root-only folder or file is refused, logged, and the target
#   keeps its owner, mode, text and entries;
#   fff_dir gives fff an existing folder of root's, and refuses a link.
# It also prints, for the record only, what the old `install -d -o fff` did to a link (follow it or not).
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
here=$(pwd)
G=$here/deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
if [ "$(id -u)" != 0 ]; then echo "skip: fff-root-links.test.sh needs root (lint.sh --units on a throwaway machine)"; exit 0; fi
for c in runuser find stat; do command -v "$c" >/dev/null || fail "needs $c"; done

U=fffrootlinktest
id "$U" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$U"
T=$(mktemp -d)
T=$(cd -P "$T" && pwd)
cleanup() { pkill -u "$U" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
chmod 0755 "$T"
R=$T/srv/fff
mkdir -p "$T/srv"
install -d -m 1770 -o root -g "$U" "$R"
install -d -m 0700 -o "$U" -g "$U" "$R/data" "$R/config" "$R/home"
V=$T/victim
install -d -m 0755 -o root -g root "$V"
printf 'root only\n' >"$V/secret"
chmod 0600 "$V/secret"
printf 'FFF_ROOT=%s\nFFF_USER=%s\n' "$R" "$U" >"$T/fff.conf"
# lib FUNCTION ARGS...: a function of lib.sh as root, its log to $T/log; stdin passes through.
lib() { FFF_CONF=$T/fff.conf FFF_LIB=$G bash -c '. "$FFF_LIB/lib.sh"; load_conf; "$@"' _ "$@" 2>>"$T/log"; }
as_u() { runuser -u "$U" -- "$@"; }
victim_same() {
  [ "$(stat -c '%U:%G %a' "$V")" = "root:root 755" ] || fail "$1: the victim folder became $(stat -c '%U:%G %a' "$V")"
  [ "$(stat -c '%U:%G %a' "$V/secret")" = "root:root 600" ] || fail "$1: the victim file became $(stat -c '%U:%G %a' "$V/secret")"
  [ "$(cat "$V/secret")" = "root only" ] || fail "$1: the victim file's text changed"
  [ "$(find "$V" -mindepth 1 | wc -l)" = 1 ] || fail "$1: something new in the victim folder: $(find "$V" -mindepth 1)"
}
refused() { grep -q "refused" "$T/log" || fail "$1: nothing logged"; : >"$T/log"; }
: >"$T/log"

# 0. For the record: the old root step, `install -d -o fff` on a link fff made to a root folder.
mkdir "$T/old" && install -d -m 0755 -o root -g root "$T/old/target" && ln -s "$T/old/target" "$T/old/inbox"
if install -d -m 0700 -o "$U" -g "$U" "$T/old/inbox" 2>/dev/null; then
  echo "info: the old install -d -o fff on a link left its target $(stat -c '%U:%G %a' "$T/old/target") (was root:root 755)"
else
  echo "info: the old install -d -o fff on a link failed"
fi
rm -rf "$T/old"

# 1. A normal message to the dispatcher.
lib tell_dispatcher "hello" || fail "tell_dispatcher on a normal folder: $(cat "$T/log")"
[ "$(stat -c '%U %a' "$R/data/orchestrator-inbox")" = "$U 700" ] || fail "inbox is $(stat -c '%U %a' "$R/data/orchestrator-inbox")"
f=$(find "$R/data/orchestrator-inbox" -name '*.txt')
if [ -z "$f" ] || [ "$(printf '%s\n' "$f" | wc -l)" != 1 ]; then fail "want one message, got: $f"; fi
[ "$(stat -c '%U %a' "$f")" = "$U 600" ] || fail "message is $(stat -c '%U %a' "$f")"
[ "$(cat "$f")" = hello ] || fail "message text: $(cat "$f")"
[ -z "$(find "$R/data/orchestrator-inbox" -name '.*')" ] || fail "a temp file was left"
ok "tell_dispatcher writes fff's 0600 message in fff's 0700 inbox"

# 2. fff swaps the inbox for a link to a root folder.
as_u rm -rf "$R/data/orchestrator-inbox"
as_u ln -s "$V" "$R/data/orchestrator-inbox"
if lib tell_dispatcher "evil"; then fail "tell_dispatcher followed an inbox link"; fi
refused "inbox link"
victim_same "inbox link"
ok "tell_dispatcher refuses an inbox that is a link, logs it, and leaves the target alone"
as_u rm -f "$R/data/orchestrator-inbox"

# 3. fff swaps its whole data folder (the sticky $FFF_ROOT lets it: its own entry).
as_u mv "$R/data" "$R/data.real" || fail "fff could not rename its data folder (the swap the finding needs)"
as_u ln -s "$V" "$R/data"
if lib tell_dispatcher "evil"; then fail "tell_dispatcher followed a data folder link"; fi
refused "data link, tell_dispatcher"
if printf 'x\n' | lib data_write secret; then fail "data_write followed a data folder link"; fi
refused "data link, data_write"
victim_same "data link"
ok "fff can swap its data folder for a link; tell_dispatcher and data_write refuse it"
as_u rm -f "$R/data"
as_u mv "$R/data.real" "$R/data"

# 4. A normal data_write.
printf 'v1\n' | lib data_write state.json || fail "data_write on a normal folder: $(cat "$T/log")"
[ "$(stat -c '%U %a' "$R/data/state.json")" = "$U 600" ] || fail "data_write wrote $(stat -c '%U %a' "$R/data/state.json")"
[ "$(cat "$R/data/state.json")" = v1 ] || fail "data_write text: $(cat "$R/data/state.json")"
printf 'v2\n' | lib data_write state.json || fail "data_write again: $(cat "$T/log")"
[ "$(cat "$R/data/state.json")" = v2 ] || fail "data_write did not replace the file"
ok "data_write writes fff's 0600 file, and replaces it"

# 5. fff swaps a data file for a link to a root file.
as_u rm -f "$R/data/state.json"
as_u ln -s "$V/secret" "$R/data/state.json"
if printf 'evil\n' | lib data_write state.json; then fail "data_write followed a file link"; fi
refused "file link"
victim_same "file link"
ok "data_write refuses a file that is a link, and leaves its target alone"
as_u rm -f "$R/data/state.json"

# 6. fff_dir gives fff a folder of root's.
install -d -m 0755 -o root -g root "$R/data/rootmade"
lib fff_dir "$R/data/rootmade" || fail "fff_dir on root's folder: $(cat "$T/log")"
[ "$(stat -c '%U %a' "$R/data/rootmade")" = "$U 700" ] || fail "fff_dir left $(stat -c '%U %a' "$R/data/rootmade")"
if lib fff_dir "$R/data/new/sub"; then fail "fff_dir made a folder whose parent is missing"; fi
grep -q "does not exist" "$T/log" || fail "fff_dir with a missing parent logged: $(cat "$T/log")"
: >"$T/log"
lib fff_dir "$R/data/new" "$R/data/new/sub" || fail "fff_dir parent then child: $(cat "$T/log")"
[ "$(stat -c '%U %a' "$R/data/new/sub")" = "$U 700" ] || fail "fff_dir child is $(stat -c '%U %a' "$R/data/new/sub")"
ok "fff_dir gives fff a folder of root's and makes new ones, 0700"

# 7. fff_dir on a link.
as_u ln -s "$V" "$R/data/linked"
if lib fff_dir "$R/data/linked"; then fail "fff_dir followed a link"; fi
refused "fff_dir link"
victim_same "fff_dir link"
ok "fff_dir refuses a link"
echo "fff-root-links: all passed"
