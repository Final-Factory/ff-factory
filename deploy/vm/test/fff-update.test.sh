#!/usr/bin/env bash
# fff-update's trust in the release it runs code from as root (w5505), against a fixture /srv/fff, a local origin and a
# fake npm and systemctl: run by lint.sh --units (root; skipped otherwise). What it checks:
#   the move from a layout fff made (its clone, its release, its links) to root's: $FFF_ROOT root:fff 1770, $APP, the
#   clone and every release root's and read-only to fff, the old release still readable by fff's git;
#   a release is built as fff and then made root's (fff can write nothing in it), node_modules reused as root's links;
#   release_problem refuses a mismatched commit, a changed, added or ignored file, a symbolic link on the way or out of the
#   tree, a file not root's or writable by others, a forged .git, a .ready not root's or naming another commit;
#   activate takes no forged record (fff's data/update.prepared.json, a root record of a mismatched or dirty tree) and
#   installs nothing from it, and switches to the root record's release when it is fit;
#   rollback goes back only to a fit root's release;
#   a build that keeps a file open for writing, leaves a link out of the tree or adds a file is never marked ready.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
here=$(pwd)
G=$here/deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }
if [ "$(id -u)" != 0 ]; then echo "skip: fff-update.test.sh needs root (lint.sh --units on a throwaway machine)"; exit 0; fi
for c in git jq runuser find realpath; do command -v "$c" >/dev/null || fail "needs $c"; done

U=fffupdtest
id "$U" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$U"
T=$(mktemp -d)
T=$(cd -P "$T" && pwd)
cleanup() { pkill -u "$U" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
chmod 0755 "$T"
R=$T/srv/fff
APP=$R/app RELEASES=$R/app/releases REPO=$R/app/repo.git CURRENT=$R/app/current PREVIOUS=$R/app/previous PREPARED=$R/app/update.prepared.json
mkdir -p "$T/srv" "$T/lib" "$T/bin"
install -d -m 0700 -o "$U" -g "$U" "$R" "$R/home" "$R/data" "$APP" "$RELEASES"
cp "$G/lib.sh" "$G/fff.conf.example" "$G/fff-update" "$T/lib/"
cp "$T/lib/lib.sh" "$T/lib.sh.orig"
cat >"$T/fff.conf" <<EOF
FFF_ROOT=$R
FFF_USER=$U
FFF_BRANCH=main
FFF_REPO_URL=$T/src.git
RELEASES_KEEP_EXTRA=5
EOF
# npm: "ci" installs one dependency with a link in .bin; "--prefix web run build" writes web/dist, and does harm as
# $T/evil says: holdfd (keeps the built file open for writing), outlink (a link out of the tree), untracked (a file).
cat >"$T/bin/npm" <<'EOF'
#!/usr/bin/env bash
evil=$(cat "${FAKE_NPM_EVIL:-@EVIL@}" 2>/dev/null || true)
case "$1" in
  ci) mkdir -p node_modules/dep/bin node_modules/.bin; echo 'module.exports = 1' >node_modules/dep/index.js
    echo x >node_modules/dep/bin/x; ln -sfn ../dep/bin/x node_modules/.bin/x ;;
  --prefix)
    mkdir -p "$2/dist"; echo built >"$2/dist/index.html"
    case $evil in
      holdfd) nohup bash -c 'exec 3>>"$1"; sleep 60' _ "$PWD/$2/dist/index.html" >/dev/null 2>&1 & ;;
      outlink) ln -s /etc "$2/dist/etc" ;;
      untracked) echo x >stray.txt ;;
    esac ;;
esac
EOF
sed -i "s|@EVIL@|$T/evil|" "$T/bin/npm"
printf '#!/bin/sh\nexit 0\n' >"$T/bin/systemctl"
chmod 0755 "$T/bin/npm" "$T/bin/systemctl"
: >"$T/evil"
chmod 0644 "$T/evil"
export FFF_LIB=$T/lib FFF_CONF=$T/fff.conf FAKE_NPM_EVIL=$T/evil PATH=$T/bin:$PATH
upd() { "$T/lib/fff-update" "$@"; }
as_u() { (cd / && runuser -u "$U" -- env HOME="$R/home" GIT_TERMINAL_PROMPT=0 "$@"); }
# problem DIR SHA: release_problem's answer, from lib.sh as fff-update has it.
problem() { bash -c '. "$1/lib.sh"; load_conf; release_problem "$2" "$3"' _ "$T/lib" "$1" "$2"; }
mode() { stat -c '%U:%G %a' "$1"; }

# The origin: S0, S1, S2, S3 on main; deploy/vm/guest without fffctl, so no release installs scripts here.
git init -q -b main "$T/src"
gs() { git -C "$T/src" -c user.name=t -c user.email=t@example.invalid "$@"; }
mkdir -p "$T/src/server" "$T/src/web" "$T/src/deploy/vm/guest"
printf 'node_modules/\nweb/dist/\n*.log\n' >"$T/src/.gitignore"
echo '{"name":"t","version":"1.0.0"}' >"$T/src/package.json"
echo '{"name":"t","lockfileVersion":3,"packages":{"":{"name":"t"}}}' >"$T/src/package-lock.json"
cp "$T/src/package.json" "$T/src/package-lock.json" "$T/src/web/"
echo 'readme' >"$T/src/deploy/vm/guest/README"
for n in 0 1 2 3; do echo "export const n = $n" >"$T/src/server/index.ts"; gs add -A; gs commit -q -m "s$n"; done
S3=$(gs rev-parse HEAD); S2=$(gs rev-parse HEAD~1); S1=$(gs rev-parse HEAD~2); S0=$(gs rev-parse HEAD~3)
git clone -q --bare "$T/src" "$T/src.git"
git -C "$T/src.git" update-ref refs/heads/main "$S0"
chmod -R a+rX "$T/src.git"
as_u git config --global --add safe.directory "$T/src.git"
r() { echo "$RELEASES/${1:0:12}"; }

# ---- 1. A layout fff made before w5505: its clone, its release of S0, its links and files in $APP.
as_u git clone -q --bare "$T/src.git" "$REPO"
as_u git -C "$REPO" worktree add -q --detach "$(r "$S0")" "$S0"
as_u touch "$(r "$S0").ready" "$APP/last-build.log"
as_u ln -s "$(r "$S0")" "$CURRENT"
git -C "$T/src.git" update-ref refs/heads/main "$S1"
upd init origin/main
[ "$(mode "$R")" = "root:$U 1770" ] || fail "$R is $(mode "$R"), not root:$U 1770"
for p in "$APP" "$RELEASES" "$REPO" "$(r "$S1")"; do [ "$(mode "$p")" = "root:root 755" ] || fail "$p is $(mode "$p"), not root:root 755"; done
[ "$(stat -c %U "$(readlink "$CURRENT")")" = "$U" ] && [ "$(stat -c %U "$CURRENT")" = root ] || fail "the current link is not root's, or no longer leads to fff's old release"
[ ! -e "$APP/last-build.log" ] || fail "fff's file in $APP was left there"
[ "$(cat "$(r "$S1").ready")" = "$S1" ] && [ "$(stat -c %U "$(r "$S1").ready")" = root ] || fail "the release of S1 is not marked ready by root"
[ -z "$(find "$REPO" "$(r "$S1")" ! -user root -print -quit)" ] || fail "something in the clone or the new release is not root's"
[ "$(as_u git -C "$(r "$S0")" rev-parse HEAD)" = "$S0" ] || fail "fff's git no longer reads fff's old release"
[ "$(as_u git -C "$(r "$S1")" rev-parse HEAD)" = "$S1" ] || fail "fff's git does not read root's release (safe.directory)"
[ -z "$(problem "$(r "$S1")" "$S1")" ] || fail "the new release is not fit: $(problem "$(r "$S1")" "$S1")"
if as_u touch "$(r "$S1")/server/x" 2>/dev/null || as_u sh -c "echo x >>'$(r "$S1")/server/index.ts'" 2>/dev/null ||
  as_u touch "$PREPARED" 2>/dev/null || as_u mv "$APP" "$R/app2" 2>/dev/null; then
  fail "fff could write into the release, \$APP or $R's app"
fi
ok "the old layout moved to root's: the clone again, a root's release, root's links, fff's old release still read by fff's git"

# ---- 2. The update route: fff asks (data/update.wanted), root records the release, activate switches to it.
as_u sh -c "echo '{\"ref\":\"$S1\",\"drainMinutes\":0}' >'$R/data/update.wanted'"
upd request 2>"$T/request.log" || { cat "$T/request.log"; fail "fff-update request failed"; }
[ "$(mode "$PREPARED")" = "root:root 644" ] && [ "$(jq -r .dir "$PREPARED")" = "$(r "$S1")" ] || fail "no root's record of the release"
[ -f "$R/data/update.prepared.json" ] && [ -f "$R/data/restart.request" ] || fail "no copy of the record or no restart request in data"
as_u touch "$R/data/update.request"
upd activate
[ "$(readlink -e "$CURRENT")" = "$(r "$S1")" ] && [ "$(readlink -e "$PREVIOUS")" = "$(r "$S0")" ] || fail "activate did not switch to S1"
[ ! -e "$PREPARED" ] && [ ! -e "$R/data/update.prepared.json" ] || fail "the records outlived the activation"
ok "request records the release as root's, activate switches to it"
if upd rollback test 2>"$T/rb.log"; then fail "rolled back to fff's old release"; fi
matches 'not root' "$T/rb.log" || matches 'not fit' "$T/rb.log" || { cat "$T/rb.log"; fail "the refusal does not say why"; }
[ "$(readlink -e "$CURRENT")" = "$(r "$S1")" ] || fail "a refused rollback moved current"
ok "rollback to fff's old release is refused"

# ---- 3. A second release reuses node_modules as root's links.
git -C "$T/src.git" update-ref refs/heads/main "$S2"
upd prepare origin/main >/dev/null
R1=$(r "$S1") R2=$(r "$S2")
[ "$(stat -c %i "$R1/node_modules/dep/index.js")" = "$(stat -c %i "$R2/node_modules/dep/index.js")" ] || fail "node_modules was not reused"
[ -z "$(problem "$R2" "$S2")" ] || fail "the second release is not fit: $(problem "$R2" "$S2")"

# ---- 4. release_problem: each change is refused, and undoing it makes the release fit again.
refused() { local p; p=$(problem "${3:-$R2}" "${4:-$S2}"); [ -n "$p" ] || fail "not refused: $1"; matches -E "$2" <<<"$p" || fail "$1: refused for another reason: $p"; }
fit() { [ -z "$(problem "$R2" "$S2")" ] || fail "after $1, still refused: $(problem "$R2" "$S2")"; }
refused "a mismatched commit" "is at $S2, not|is not $RELEASES" "$R2" "$S1"
refused "the folder of another commit" "is not $RELEASES" "$R1" "$S2"
refused "no full commit id" "no full commit" "$R2" "${S2:0:12}"
cp -p "$R2/server/index.ts" "$T/keep"; echo '// x' >>"$R2/server/index.ts"; refused "a changed tracked file" "not clean"; cp -p "$T/keep" "$R2/server/index.ts"; fit "a changed file"
echo x >"$R2/stray.txt"; refused "an untracked file" "not clean"; rm "$R2/stray.txt"; fit "an untracked file"
echo x >"$R2/server/debug.log"; refused "an ignored file outside the dependencies and the build" "not clean"; rm "$R2/server/debug.log"; fit "an ignored file"
mkdir "$R2/node_modules/extra"; ln -s /etc "$R2/node_modules/extra/etc"; refused "a link out of the tree" "leads out"; rm -r "$R2/node_modules/extra"; fit "a link out"
chown "$U" "$R2/server/index.ts"; refused "a file not root's" "not root's"; chown root "$R2/server/index.ts"; fit "a file not root's"
chmod g+w "$R2/server"; refused "a folder writable by its group" "writable"; chmod g-w "$R2/server"; fit "a group-writable folder"
chmod u+s "$R2/server/index.ts"; refused "a setuid file" "setuid"; chmod u-s "$R2/server/index.ts"; fit "a setuid file"
cp -p "$R2/.git" "$T/keepgit"; echo "gitdir: $T/src.git" >"$R2/.git"; refused "a forged .git" "does not point|not a worktree|is at"; cp -p "$T/keepgit" "$R2/.git"; fit "a forged .git"
chown "$U" "$R2.ready"; refused "a .ready not root's" "not root's"; chown root "$R2.ready"; fit "a .ready not root's"
echo "$S1" >"$R2.ready"; refused "a .ready of another commit" "does not name"; echo "$S2" >"$R2.ready"; fit "a .ready of another commit"
mv "$R2" "$R2.real"; ln -s "$R2.real" "$R2"; refused "a release folder that is a link" "not a folder|symbolic link"; rm "$R2"; mv "$R2.real" "$R2"; fit "a linked folder"
mv "$APP" "$R/app.real"; ln -s "$R/app.real" "$APP"; refused "an app folder that is a link" "symbolic link"; rm "$APP"; mv "$R/app.real" "$APP"; fit "a linked app folder"
ok "release_problem refuses a mismatched commit, changed, added and ignored files, links on the way and out, a file not root's, writable or setuid, a forged .git, a wrong .ready"

# ---- 5. Forged records: activate takes neither fff's copy nor a root record of an unfit tree, and installs nothing.
F=$R/data/evil
as_u mkdir -p "$F/deploy/vm/guest"
as_u sh -c "echo '# forged' >'$F/deploy/vm/guest/lib.sh'; echo '# forged' >'$F/deploy/vm/guest/fffctl'; chmod +x '$F/deploy/vm/guest/fffctl'; touch '$F.ready'"
as_u sh -c "echo '{\"sha\":\"$S2\",\"dir\":\"$F\"}' >'$R/data/update.prepared.json'; touch '$R/data/update.request'"
upd activate 2>"$T/act.log" || { cat "$T/act.log"; fail "activate failed"; }
matches 'not taken' "$T/act.log" || { cat "$T/act.log"; fail "activate did not say it refused fff's record"; }
[ "$(readlink -e "$CURRENT")" = "$R2" ] || fail "after a forged record, current is $(readlink -e "$CURRENT"), not origin/main's release"
cmp -s "$T/lib/lib.sh" "$T/lib.sh.orig" || fail "scripts were installed from the forged release"
ok "fff's forged record is not taken; activate builds origin/main's release instead and installs nothing from the forgery"
upd rollback test >/dev/null 2>&1 || fail "rollback to a fit root's release failed"
[ "$(readlink -e "$CURRENT")" = "$R1" ] || fail "rollback did not go back to S1"
ok "rollback goes back to a fit root's release"
printf '{"sha":"%s","dir":"%s"}\n' "$S1" "$R2" >"$PREPARED"
as_u touch "$R/data/update.request"
upd activate 2>"$T/act2.log" || { cat "$T/act2.log"; fail "activate failed"; }
matches 'not taken' "$T/act2.log" || { cat "$T/act2.log"; fail "a root record of a mismatched tree was taken"; }
[ "$(readlink -e "$CURRENT")" = "$R2" ] || fail "after a mismatched record, current is not origin/main's release"
echo x >"$R1/stray.txt"
printf '{"sha":"%s","dir":"%s"}\n' "$S1" "$R1" >"$PREPARED"
as_u touch "$R/data/update.request"
upd activate 2>"$T/act3.log" || { cat "$T/act3.log"; fail "activate failed"; }
matches 'not clean' "$T/act3.log" && [ "$(readlink -e "$CURRENT")" = "$R2" ] || { cat "$T/act3.log"; fail "a root record of a dirty tree was taken"; }
if upd rollback test 2>/dev/null; then fail "rolled back to a dirty release"; fi
rm "$R1/stray.txt"
ok "a root record of a mismatched or dirty tree is not taken, and rollback to a dirty release is refused"

# ---- 6. A build that leaves a writer, a link out of the tree or an added file is never marked ready.
git -C "$T/src.git" update-ref refs/heads/main "$S3"
for e in holdfd outlink untracked; do
  echo "$e" >"$T/evil"
  if upd prepare origin/main >/dev/null 2>"$T/evil-$e.log"; then fail "a build that did $e was marked ready"; fi
  [ ! -e "$(r "$S3").ready" ] || fail "$e: the release is marked ready"
  pkill -u "$U" sleep 2>/dev/null || true
done
matches 'still writes into' "$T/evil-holdfd.log" || { cat "$T/evil-holdfd.log"; fail "holdfd: refused for another reason"; }
matches 'leads out' "$T/evil-outlink.log" || { cat "$T/evil-outlink.log"; fail "outlink: refused for another reason"; }
matches 'not clean' "$T/evil-untracked.log" || { cat "$T/evil-untracked.log"; fail "untracked: refused for another reason"; }
: >"$T/evil"
upd prepare origin/main >/dev/null 2>"$T/s3.log" || { cat "$T/s3.log"; fail "a clean build after the refused ones failed"; }
[ -z "$(problem "$(r "$S3")" "$S3")" ] || fail "the rebuilt release is not fit"
ok "a build that keeps a file open for writing, leaves a link out or adds a file is refused; the next clean one builds"
echo "fff-update.test.sh: all passed"
