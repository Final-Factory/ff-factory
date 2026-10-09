#!/usr/bin/env bash
# The host side of the token vault (deploy/vm/host/vault.sh, w744): `sudo fff-vm vault-sync` and the installer's own sync
# are the same function and agree. Against a fake ssh into a fake VM vault, no root and no VM, run by lint.sh.
#   - a person with only claude-tokens/<name> (the pool), alone and beside claude-token, is added and never removed;
#   - the standalone `fff-vm vault-sync` and the function the installer calls (guest.sh) end in the same vault;
#   - an entry whose file exists is never removed, even when the file is not a token now; one whose file is gone is;
#   - a scan that finds no token file at all removes nothing unless --prune says so;
#   - install_host_scripts (lib.sh) puts the checkout's vault.sh, lib.sh, pathwatch.sh and fff-vm where the installed fff-vm
#     runs them, and install.sh calls it in every mode, --guest-only included (w744: it did not, and the installed older
#     vault.sh removed the entries the installer had just added);
#   - the entries named before w748 (host-<person>-claude[-<n>], host-<person>-github) are renamed to vault-<person>[-<n>] /
#     vault-<person>-github by the portal's put (its meters, owner and token stay), never removed while their file exists, kept
#     with a warning while the portal is too old to rename, and dropped when a changed file made a second entry;
#   - no token value reaches any output.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
ROOT=$PWD
H=$ROOT/deploy/vm/host
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }
command -v sha256sum >/dev/null || fail "sha256sum is needed"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/etc/secrets/people" "$T/etc/ssh" "$T/vm/vault" "$T/state" "$T/run"
chmod 0700 "$T/etc" "$T/etc/secrets" "$T/etc/secrets/people"
export FAKE=$T/vm

# --- the fake VM: ssh runs the few commands vault.sh sends, over a vault folder with one file per entry (owner|sha256 of the value)
# shellcheck disable=SC2016 # the fake ssh below is written single-quoted on purpose: it reads its variables when it runs
cat >"$T/bin/ssh" <<'EOF'
#!/usr/bin/env bash
# fake ssh: drop the options up to user@host, the rest is the remote command line
while [ $# -gt 0 ]; do case "$1" in -i | -o) shift 2 ;; *@*) shift; break ;; *) shift ;; esac; done
cmd="$*"
V=$FAKE/vault
mkdir -p "$FAKE/values" "$FAKE/meta"
# an option of `vault put`: --NAME VALUE (a value in single quotes loses them)
opt() { sed -nE "s/.* --$1 ('[^']*'|[^ ]+).*/\1/p" <<<"$cmd" | tr -d "'"; }
case "$cmd" in
  'sudo fffctl vault list --names') ls "$V" ;;
  'sudo fffctl vault export --manifest')
    [ -z "${FAKE_NO_EXPORT:-}" ] || { echo "vault: unknown command export (list, add, rotate, grant, rename, remove, new-key, machine-credential)" >&2; exit 2; }
    for m in "$FAKE"/meta/*; do
      [ -f "$m" ] || continue
      n=$(basename "$m")
      [ -f "$V/$n" ] || continue
      IFS='|' read -r kind env owner share roles machines <"$m"
      v=$(tr -d '[:space:]' <"$FAKE/values/$n")
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t0\n' "$n" "$kind" "${env:--}" "${owner:--}" "$share" "$roles" "$machines" "$(printf %s "$v" | sha256sum | cut -c1-12)" "${v: -4}"
    done
    # a line as a hostile VM could send it
    [ -z "${FAKE_MANIFEST_EXTRA:-}" ] || printf '%b\n' "$FAKE_MANIFEST_EXTRA" ;;
  'sudo fffctl vault export '*)
    [ -z "${FAKE_NO_EXPORT:-}" ] || exit 2
    name=${cmd##* }
    [ -f "$FAKE/values/$name" ] || exit 1
    echo "export $name" >>"$FAKE/calls"
    if [ -n "${FAKE_EXPORT_WRONG:-}" ]; then printf 'sk-ant-oat01-%s\n' "$(head -c 96 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9' | head -c 44)"; else cat "$FAKE/values/$name"; fi ;;
  'sudo fffctl vault put '*)
    name=$(sed -E 's/.*--name ([^ ]+).*/\1/' <<<"$cmd")
    owner=$(sed -E 's/.*--owner ([^ ]+).*/\1/' <<<"$cmd")
    val=$(cat)
    new=$(printf '%s\n' "$val" | sha256sum | cut -d' ' -f1)
    want="$owner|$new"
    # the portal's rename (w748): no entry of this name, a host-… one holding this very token: it takes the new name
    if [ ! -f "$V/$name" ] && [ "${name#vault-}" != "$name" ]; then
      for old in "$V"/host-*; do
        [ -f "$old" ] || continue
        if [ "$(cut -d'|' -f2 "$old")" = "$new" ] && [ -z "${FAKE_OLD_PORTAL:-}" ]; then mv "$old" "$V/$name"; echo "renamed: $name (was $(basename "$old"))"; echo "renamed $name" >>"$FAKE/calls"; exit 0; fi
        if [ "$(cut -d'|' -f2 "$old")" = "$new" ]; then echo "vault: that value is already in the vault as $(basename "$old")" >&2; exit 1; fi
      done
    fi
    printf '%s\n' "$val" >"$FAKE/values/$name"
    printf '%s|%s|%s|%s|%s|%s\n' "$(opt kind)" "$(opt env)" "$(opt owner)" "$(opt share)" "$(opt roles)" "$(opt machines)" >"$FAKE/meta/$name"
    if [ -f "$V/$name" ]; then
      if [ "$(cat "$V/$name")" = "$want" ]; then echo "unchanged: $name"; else echo "$want" >"$V/$name"; echo "rotated: $name"; fi
    else
      echo "$want" >"$V/$name"
      echo "added: $name"
    fi
    echo "put $name" >>"$FAKE/calls" ;;
  'sudo fffctl vault remove '*) name=${cmd##* }; rm -f "$V/$name" "$FAKE/values/$name" "$FAKE/meta/$name"; echo "removed $name" >>"$FAKE/calls"; echo "removed $name" ;;
  'sudo sha256sum /etc/fff/vault.key'*) echo "$(sha256sum <"$FAKE/vault.key" | cut -d' ' -f1)  /etc/fff/vault.key" ;;
  'sudo cat /etc/fff/vault.key') cat "$FAKE/vault.key" ;;
  *) echo "fake ssh: $cmd is not faked" >&2; exit 1 ;;
esac
EOF
chmod +x "$T/bin/ssh"
# shellcheck disable=SC2016 # a script written single-quoted: it reads its arguments when it runs
printf '#!/bin/sh\n[ "$1" = -u ] && echo 0 || exec /usr/bin/id "$@"\n' >"$T/bin/id"
chmod +x "$T/bin/id"
# fff-vm refuses to run as a non-root account; its conf only has to exist
printf 'VM_DISK_MODE=qcow2\n' >"$T/fff-vm.conf"
printf 'the key of the fake VM\n' >"$FAKE/vault.key"
cp "$FAKE/vault.key" "$T/etc/secrets/vault.key"
export PATH=$T/bin:$PATH
export VM_ADMIN_USER=fffadmin NET_VM_IP=10.213.41.10
export FFF_VM_LIB=$H FFF_VM_CONF=$T/fff-vm.conf FFF_VM_ETC=$T/etc FFF_VM_STATE=$T/state FFF_VM_RUN=$T/run TMPDIR=$T
# the key vssh names; the fake ssh never reads it, but vault_pull looks for it
touch "$T/etc/ssh/id_ed25519"

rnd() { local s; s=$(head -c 96 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }
tok() { printf 'sk-ant-oat01-%s' "$(rnd 44)"; }
put() { # PERSON RELATIVE-PATH VALUE
  mkdir -p "$T/etc/secrets/people/$1/$(dirname "$2")"
  printf '%s\n' "$3" >"$T/etc/secrets/people/$1/$2"
  chmod 0600 "$T/etc/secrets/people/$1/$2"
}
fresh() {
  rm -rf "$T/etc/secrets/people" "$T/etc/secrets/vault-extra" "$T/etc/secrets/vault-synced" "$FAKE/vault" "$FAKE/values" "$FAKE/meta" "$FAKE/calls"
  mkdir -p "$T/etc/secrets/people" "$FAKE/vault" "$FAKE/values" "$FAKE/meta"
  chmod 0700 "$T/etc/secrets/people"
  : >"$FAKE/calls"
}
# vm_add NAME KIND OWNER VALUE [ENV [SHARE [ROLES [MACHINES]]]]: an entry made in the VM (fffctl vault add-claude, or by hand): the
# portal holds it, the host has no file for it
vm_add() {
  printf '%s|%s
' "$3" "$(printf '%s
' "$4" | sha256sum | cut -d' ' -f1)" >"$FAKE/vault/$1"
  printf '%s
' "$4" >"$FAKE/values/$1"
  printf '%s|%s|%s|%s|%s|%s
' "$2" "${5:-}" "$3" "${6:-owner}" "${7:-workers,standing}" "${8:-*}" >"$FAKE/meta/$1"
}
people_file() { echo "$T/etc/secrets/people/$1"; }
vm_value() { cat "$FAKE/values/$1"; }
# the host's nightly copy alone: fff-vm vault-pull
pull() { bash "$H/fff-vm" vault-pull 2>&1 || true; }
mode() { stat -c %a "$1"; }
# modeis FILE MODE: the file has that mode (checked where the file system keeps modes: Linux, as CI is; not NTFS under Git Bash)
touch "$T/modeprobe" && chmod 0600 "$T/modeprobe"
MODES=1
[ "$(mode "$T/modeprobe")" = 600 ] || MODES=0
modeis() { [ "$MODES" = 0 ] || [ "$(mode "$1")" = "$2" ]; }
names() { find "$FAKE/vault" -type f -printf '%f\n' | sort | paste -sd' ' -; }
calls() { grep -c "^$1" "$FAKE/calls" || true; }
# the standalone path: the installed command, as lothsahn runs it
standalone() { bash "$H/fff-vm" vault-sync "$@" 2>&1 || true; }
# the installer's path: guest.sh sources vault.sh from the checkout and calls vault_sync (a subshell, like a run of install.sh)
installer() {
  (
    # shellcheck source=../host/lib.sh
    . "$H/lib.sh"
    # shellcheck source=../host/vault.sh
    . "$H/vault.sh"
    DRY_RUN=0
    vault_sync 2>&1
  ) || true
}
secret=""
noleak() { local v; for v in "$@"; do if printf '%s' "$secret" | matches -F "${v:13:30}"; then fail "a token value reached the output"; fi; done; }

# ---------------------------------------------------------------- a person with only claude-tokens/ (lothsahn's host, 2026-10-09)
fresh
b1=$(tok); b2=$(tok); l1=$(tok)
put ben claude-tokens/1 "$b1"; put ben claude-tokens/2 "$b2"; put lothsahn claude-tokens/1 "$l1"
out=$(standalone); secret=$out; noleak "$b1" "$b2" "$l1"
[ "$(names)" = "vault-ben-1 vault-ben-2 vault-lothsahn-1" ] || fail "pool-only: the standalone sync made: $(names): $out"
printf '%s' "$out" | matches -F 'added vault-ben-1' || fail "pool-only: no 'added': $out"
if printf '%s' "$out" | matches 'removed'; then fail "pool-only: the standalone sync removed something: $out"; fi
out=$(standalone); secret=$out
[ "$(names)" = "vault-ben-1 vault-ben-2 vault-lothsahn-1" ] || fail "pool-only: a second sync changed the vault: $(names)"
printf '%s' "$out" | matches -F 'unchanged vault-ben-2' || fail "pool-only: a second sync was not a no-op: $out"
[ "$(calls removed)" = 0 ] || fail "pool-only: something was removed"
# the installer's function, from a fresh vault, ends in the same vault
set_a=$(names)
rm -rf "$FAKE/vault"; mkdir -p "$FAKE/vault"
out=$(installer); secret=$out; noleak "$b1" "$b2" "$l1"
[ "$(names)" = "$set_a" ] || fail "pool-only: the installer's sync made: $(names), the standalone: $set_a"
# and the standalone sync right after the installer's removes none of it: the exact sequence of the report
out=$(standalone); secret=$out
[ "$(names)" = "$set_a" ] || fail "pool-only: install.sh then fff-vm vault-sync left: $(names)"
ok "claude-tokens/<name> alone: the standalone sync and the installer's make the same three entries, and the sync after the installer removes none"

# ---------------------------------------------------------------- beside claude-token, and the owner of each entry
fresh
c=$(tok); c1=$(tok)
put ben claude-token "$c"; put ben claude-tokens/1 "$c1"; put ben claude-tokens/Second "$(tok)"
out=$(standalone); secret=$out; noleak "$c" "$c1"
[ "$(names)" = "vault-ben vault-ben-1 vault-ben-second" ] || fail "beside claude-token: $(names): $out"
for n in vault-ben vault-ben-1 vault-ben-second; do
  [ "$(cut -d'|' -f1 "$FAKE/vault/$n")" = ben ] || fail "$n is not ben's"
done
out=$(standalone)
[ "$(names)" = "vault-ben vault-ben-1 vault-ben-second" ] && [ "$(calls removed)" = 0 ] || fail "beside claude-token: a second sync changed the vault"
ok "claude-tokens/<name> beside claude-token: all in as the person's, a name in upper case read as lower, none removed on the next sync"

# ---------------------------------------------------------------- never remove an entry whose file exists; remove one whose file is gone
fresh
a=$(tok); b=$(tok)
put ben claude-token "$a"; put ben claude-tokens/2 "$b"; put sam github-token "github_pat_$(rnd 40)"
standalone >/dev/null
echo "x|y" >"$FAKE/vault/max-discord"            # not a vault-*/host-* entry: never touched
put sam claude-tokens/gone "$(tok)"           # a pool file that is deleted below: its entry goes with it
standalone >/dev/null
[ -f "$FAKE/vault/vault-sam-gone" ] || fail "setup: the entry of the file to delete is not in the vault"
rm -f "$T/etc/secrets/people/sam/claude-tokens/gone"
out=$(standalone); secret=$out
[ -f "$FAKE/vault/vault-sam-gone" ] && fail "an entry whose file was removed stayed: $out"
[ -e "$T/etc/secrets/people/sam/claude-tokens/gone" ] && fail "the pull copied a removed file back from the VM: $out"
printf '%s' "$out" | matches -F 'removed vault-sam-gone' || fail "the removal is not logged: $out"
printf '%s' "$out" | matches -F 'not copied: vault-sam-gone' || fail "the pull does not say it left the removed file's entry out: $out"
[ -f "$FAKE/vault/max-discord" ] || fail "an entry that is not vault-*/host-* was removed"
[ -f "$FAKE/vault/vault-ben-2" ] && [ -f "$FAKE/vault/vault-ben" ] && [ -f "$FAKE/vault/vault-sam-github" ] || fail "an entry whose file exists was removed: $(names)"
# its file turns into garbage (a bad paste): the entry stays, the warning says why, the exit is 1
printf '%s\n' 'not a token at all' >"$T/etc/secrets/people/ben/claude-tokens/2"
out=$(standalone); secret=$out
[ -f "$FAKE/vault/vault-ben-2" ] || fail "a file that is not a token now got its entry removed: $out"
printf '%s' "$out" | matches 'is not one' || fail "no warning for the bad file: $out"
if printf '%s' "$out" | matches 'not at all'; then fail "the bad content was printed"; fi
# the file is deleted: now the entry goes
rm -f "$T/etc/secrets/people/ben/claude-tokens/2"
standalone >/dev/null
[ -f "$FAKE/vault/vault-ben-2" ] && fail "an entry whose file is gone stayed"
[ -f "$FAKE/vault/vault-ben" ] || fail "the other entry of the person went too"
ok "an entry whose file exists is never removed (a bad paste included); one whose file is gone is; others' entries are left"

# ---------------------------------------------------------------- a scan that finds nothing removes nothing, unless --prune
fresh
put ben claude-tokens/1 "$(tok)"; put lothsahn claude-token "$(tok)"
standalone >/dev/null
[ "$(names)" = "vault-ben-1 vault-lothsahn" ] || fail "setup: $(names)"
rm -rf "$T/etc/secrets/people" && mkdir -p "$T/etc/secrets/people" && chmod 0700 "$T/etc/secrets/people"
out=$(standalone); secret=$out
[ "$(names)" = "vault-ben-1 vault-lothsahn" ] || fail "a scan that found no file removed entries: $(names): $out"
printf '%s' "$out" | matches 'found no token file' || fail "no warning that nothing was removed: $out"
printf '%s' "$out" | matches -F 'sudo fff-vm vault-sync --prune' || fail "the warning does not name --prune: $out"
out=$(standalone --prune)
[ -z "$(names)" ] || fail "--prune did not remove them: $(names)"
out=$(standalone --nope); printf '%s' "$out" | matches 'unknown option --nope' || fail "an unknown option is not refused: $out"
ok "no token file found at all: nothing removed and --prune named; --prune removes them"

# ---------------------------------------------------------------- w748: the old names carry over to the new ones
# an entry as the sync made it before w748: its owner and the hash of the token file
old_entry() { # NAME PERSON RELATIVE-PATH
  printf '%s|%s
' "$2" "$(sha256sum <"$T/etc/secrets/people/$2/$3" | cut -d' ' -f1)" >"$FAKE/vault/$1"
}
fresh
b1=$(tok); b2=$(tok); l1=$(tok); bs=$(tok)
put ben claude-tokens/1 "$b1"; put ben claude-tokens/2 "$b2"; put lothsahn claude-tokens/1 "$l1"
put ben claude-token "$bs"; put ben github-token "github_pat_$(rnd 40)"
old_entry host-ben-claude-1 ben claude-tokens/1; old_entry host-ben-claude-2 ben claude-tokens/2; old_entry host-lothsahn-claude-1 lothsahn claude-tokens/1
old_entry host-ben-claude ben claude-token; old_entry host-ben-github ben github-token
before=$(cat "$FAKE"/vault/host-* | sort | paste -sd' ' -)
out=$(standalone); secret=$out; noleak "$b1" "$b2" "$l1" "$bs"
[ "$(names)" = "vault-ben vault-ben-1 vault-ben-2 vault-ben-github vault-lothsahn-1" ] || fail "rename: the vault holds: $(names): $out"
[ "$(cat "$FAKE"/vault/vault-* | sort | paste -sd' ' -)" = "$before" ] || fail "rename: an entry's owner or token changed"
printf '%s' "$out" | matches -F 'renamed vault-ben-1' || fail "rename: not logged: $out"
[ "$(calls removed)" = 0 ] && [ "$(calls renamed)" = 5 ] || fail "rename: removed $(calls removed), renamed $(calls renamed) (five entries rename, none is removed)"
out=$(standalone); secret=$out
[ "$(names)" = "vault-ben vault-ben-1 vault-ben-2 vault-ben-github vault-lothsahn-1" ] && [ "$(calls removed)" = 0 ] || fail "rename: the second sync changed the vault: $(names)"
printf '%s' "$out" | matches -F 'unchanged vault-ben-2' || fail "rename: a second sync was not a no-op: $out"
# the installer's sync from the old names ends in the same vault
for n in 1 2; do old_entry "host-ben-claude-$n" ben "claude-tokens/$n"; rm -f "$FAKE/vault/vault-ben-$n"; done
out=$(installer); secret=$out
[ "$(names)" = "vault-ben vault-ben-1 vault-ben-2 vault-ben-github vault-lothsahn-1" ] || fail "rename: the installer's sync left: $(names): $out"
ok "host-<person>-claude[-<n>] and host-<person>-github are renamed to vault-<person>[-<n>] and vault-<person>-github, owner and token unchanged, none removed"

# a portal too old to rename: the old entries stay, with a warning, and nothing is added beside them
fresh
b1=$(tok); put ben claude-tokens/1 "$b1"; old_entry host-ben-claude-1 ben claude-tokens/1
out=$(FAKE_OLD_PORTAL=1 standalone); secret=$out; noleak "$b1"
[ "$(names)" = "host-ben-claude-1" ] || fail "old portal: the vault holds: $(names): $out"
printf '%s' "$out" | matches 'host-ben-claude-1 stays' || fail "old portal: no warning that the old entry stays: $out"
out=$(standalone); secret=$out
[ "$(names)" = "vault-ben-1" ] || fail "old portal: after the portal update the sync left: $(names): $out"
ok "a portal that cannot rename yet keeps the old entries and says so; the next sync renames them"

# the file changed since: the old entry holds the old token, so the new entry is made and the old one goes
fresh
put ben claude-tokens/1 "$(tok)"; old_entry host-ben-claude-1 ben claude-tokens/1
put ben claude-tokens/1 "$(tok)"
out=$(standalone); secret=$out
[ "$(names)" = "vault-ben-1" ] || fail "changed file: the vault holds: $(names): $out"
printf '%s' "$out" | matches -F 'removed host-ben-claude-1 (its file now feeds vault-ben-1)' || fail "changed file: the old entry's removal is not logged: $out"
ok "an old entry left beside its new one (the file holds another token now) is removed"

# two files that make one entry name: the first wins, the second is said
fresh
put ben github-token "github_pat_$(rnd 40)"; put ben claude-tokens/github "$(tok)"
out=$(standalone); secret=$out
[ "$(names)" = "vault-ben-github" ] || fail "name clash: the vault holds: $(names): $out"
printf '%s' "$out" | matches 'would make the entry vault-ben-github' || fail "name clash: no warning: $out"
ok "two files that would make one entry: the first wins and the other is said"

# ---------------------------------------------------------------- w749: entries made in the VM are copied to the host, and a sync keeps them
# An add in the VM (fffctl vault add-claude ben, fffctl vault add-claude sam 7), then the nightly copy.
fresh
b1=$(tok); b2=$(tok); s7=$(tok)
put ben claude-tokens/1 "$b1"
standalone >/dev/null
vm_add vault-ben-2 claude ben "$b2"
vm_add vault-sam-7 claude sam "$s7"
out=$(pull); secret=$out; noleak "$b2" "$s7"
[ -f "$(people_file ben/claude-tokens/2)" ] && [ -f "$(people_file sam/claude-tokens/7)" ] || fail "nightly copy: the files are not there: $(find "$T/etc/secrets/people" -type f | sort | paste -sd' ' -): $out"
[ "$(cat "$(people_file ben/claude-tokens/2)")" = "$b2" ] && [ "$(cat "$(people_file sam/claude-tokens/7)")" = "$s7" ] || fail "nightly copy: a file does not hold the VM's token"
modeis "$(people_file ben/claude-tokens/2)" 600 && modeis "$(people_file sam/claude-tokens/7)" 600 || fail "nightly copy: a token file is not 0600"
for d in "$T/etc/secrets" "$T/etc/secrets/people" "$(people_file sam)" "$(people_file sam/claude-tokens)" "$(people_file ben/claude-tokens)"; do modeis "$d" 700 || fail "nightly copy: $d is $(mode "$d"), not 0700"; done
printf '%s' "$out" | matches -F "copied vault-ben-2 (…${b2: -4}, " || fail "nightly copy: no log line with the entry's name and last four characters: $out"
printf '%s' "$out" | matches -F "copied vault-sam-7 (…${s7: -4}, " || fail "nightly copy: no log line for sam's: $out"
printf '%s' "$out" | matches '1 already here' || fail "nightly copy: the summary does not count the entry the host already had: $out"
[ "$(calls export)" = 2 ] || fail "nightly copy: $(calls export) values left the VM, not 2 (the one the host had stays)"
out=$(pull); secret=$out; noleak "$b1" "$b2" "$s7"
[ "$(calls export)" = 2 ] && printf '%s' "$out" | matches '0 copied, 3 already here' || fail "nightly copy: a second run copied again: $out"
ok "an entry added in the VM is copied to people/<id>/claude-tokens/<n> (0600 in 0700 folders), with a log of its name and last four characters, once"

# ... and the sync after it keeps the entry, and so does a sync that comes before any copy
out=$(standalone); secret=$out; noleak "$b1" "$b2" "$s7"
[ "$(names)" = "vault-ben-1 vault-ben-2 vault-sam-7" ] && [ "$(calls removed)" = 0 ] || fail "sync after the copy: $(names), removed $(calls removed): $out"
[ "$(vm_value vault-ben-2)" = "$b2" ] || fail "sync after the copy: the entry's token changed"
fresh
b1=$(tok); b2=$(tok)
put ben claude-tokens/1 "$b1"
standalone >/dev/null
vm_add vault-ben-2 claude ben "$b2"
out=$(standalone); secret=$out; noleak "$b1" "$b2"
[ "$(names)" = "vault-ben-1 vault-ben-2" ] && [ "$(calls removed)" = 0 ] || fail "sync with no copy before it: $(names), removed $(calls removed): $out"
[ -f "$(people_file ben/claude-tokens/2)" ] || fail "sync with no copy before it: the sync did not copy first"
ok "a vault-sync keeps an entry that only the VM has (it copies it first), before or after the nightly copy"

# a VM whose portal cannot export yet: the sync removes nothing, the entry stays, the copy says why
fresh
b2=$(tok)
put ben claude-tokens/1 "$(tok)"
standalone >/dev/null
vm_add vault-ben-2 claude ben "$b2"
out=$(FAKE_NO_EXPORT=1 standalone); secret=$out; noleak "$b2"
[ -f "$FAKE/vault/vault-ben-2" ] && [ "$(calls removed)" = 0 ] || fail "old portal: the VM-only entry was removed: $out"
printf '%s' "$out" | matches 'nothing was removed' || fail "old portal: no warning that nothing was removed: $out"
printf '%s' "$out" | matches -F "fffctl update" || fail "old portal: no hint to update the portal: $out"
[ ! -f "$(people_file ben/claude-tokens/2)" ] || fail "old portal: something was copied"
ok "a portal that cannot export yet: the VM-only entry is not copied, and the sync removes nothing"

# a value that does not arrive as listed is not kept
fresh
b2=$(tok)
vm_add vault-ben-2 claude ben "$b2"
out=$(FAKE_EXPORT_WRONG=1 pull); secret=$out; noleak "$b2"
[ ! -e "$(people_file ben/claude-tokens/2)" ] || fail "a value that differs from its fingerprint was kept"
printf '%s' "$out" | matches 'did not arrive as listed' || fail "no warning for a value that differs from its fingerprint: $out"
[ -z "$(find "$T/etc/secrets" -name '.pull.*')" ] || fail "a temporary copy was left behind"
ok "a value that does not match the fingerprint the VM listed is dropped, with nothing left behind"

# ---------------------------------------------------------------- w749: the conflict rule, the host file wins
fresh
h=$(tok); m=$(tok)
put ben claude-tokens/2 "$h"
vm_add vault-ben-2 claude ben "$m"            # the VM holds another token under the same name
out=$(pull); secret=$out; noleak "$h" "$m"
[ "$(cat "$(people_file ben/claude-tokens/2)")" = "$h" ] || fail "conflict: the host file was changed by the copy"
printf '%s' "$out" | matches -F "conflict on vault-ben-2: the VM holds …${m: -4}" || fail "conflict: not logged with the VM's last four characters: $out"
printf '%s' "$out" | matches -F "the host file holds …${h: -4}" || fail "conflict: not logged with the host file's last four characters: $out"
printf '%s' "$out" | matches 'host file wins' || fail "conflict: the rule is not said: $out"
[ "$(calls export)" = 0 ] || fail "conflict: a value left the VM although the host file wins"
# the alert the nightly sends carries names and last four characters only
news=$( (. "$H/lib.sh"; . "$H/vault.sh"; DRY_RUN=0; vault_pull >/dev/null 2>&1; printf '%s' "$VAULT_PULL_NEWS") )
secret=$news; noleak "$h" "$m"
printf '%s' "$news" | matches -F "vault-ben-2 differs between the VM (…${m: -4}) and the host file (…${h: -4})" || fail "conflict: the alert text: $news"
# the alert the nightly sends carries names and last four characters only
news=$( (. "$H/lib.sh"; . "$H/vault.sh"; DRY_RUN=0; vault_pull >/dev/null 2>&1; printf '%s' "$VAULT_PULL_NEWS") )
secret=$news; noleak "$h" "$m"
printf '%s' "$news" | matches -F "vault-ben-2 differs between the VM (…${m: -4}) and the host file (…${h: -4})" || fail "conflict: the alert text: $news"
out=$(standalone); secret=$out; noleak "$h" "$m"
[ "$(vm_value vault-ben-2)" = "$h" ] || fail "conflict: the sync did not rotate the VM entry to the host file"
printf '%s' "$out" | matches -F 'rotated vault-ben-2' || fail "conflict: the rotation is not logged: $out"
[ "$(cat "$(people_file ben/claude-tokens/2)")" = "$h" ] || fail "conflict: the host file changed"
ok "same name, two values: the host file wins and is never changed, the VM entry is rotated to it by the sync, the conflict is logged with last four characters and nothing else"

# ---------------------------------------------------------------- w749: removing for good
# deleting the file here: the entry goes at the next sync and is not copied back by the copy in front of it
fresh
b1=$(tok); b2=$(tok)
put ben claude-tokens/1 "$b1"; put ben claude-tokens/2 "$b2"
standalone >/dev/null
rm -f "$(people_file ben/claude-tokens/2)"
out=$(pull); secret=$out
[ ! -e "$(people_file ben/claude-tokens/2)" ] || fail "removal: the nightly copy brought a deleted file back: $out"
out=$(standalone)
[ "$(names)" = "vault-ben-1" ] || fail "removal: after deleting the file and a sync the vault holds $(names): $out"
vm_add vault-ben-2 claude ben "$b2"                  # the same name added again in the VM later is a new entry: copied
out=$(pull)
[ -f "$(people_file ben/claude-tokens/2)" ] || fail "removal: an entry added again under a removed name was not copied: $out"
# removing in the VM only: the host file stays, the next sync adds the entry again (that is what the host file is for)
rm -f "$FAKE/vault/vault-ben-2" "$FAKE/values/vault-ben-2" "$FAKE/meta/vault-ben-2"
standalone >/dev/null
[ -f "$FAKE/vault/vault-ben-2" ] || fail "removal in the VM only: the next sync did not put the entry back from the host file"
ok "removing for good = delete the host file, then vault-sync: the entry goes and is not copied back; removed in the VM alone, the host file brings it back"

# ---------------------------------------------------------------- w749: GitHub tokens and the other kinds
fresh
gh=github_pat_$(rnd 40); classic=ghp_$(rnd 36); disc=$(rnd 60)
vm_add vault-ben-github github ben "$gh"
vm_add vault-sam-github github sam "$classic"
vm_add max-discord env "" "$disc" FFDISCORD_APP_TOKEN anyone workers lothdesktop
out=$(pull); secret=$out; noleak "$gh" "$classic" "$disc"
[ "$(cat "$(people_file ben/github-token)")" = "$gh" ] && modeis "$(people_file ben/github-token)" 600 || fail "github: a fine-grained token did not go to people/ben/github-token"
[ ! -e "$(people_file sam/github-token)" ] || fail "github: a classic token went to github-token, which the sync refuses"
X=$T/etc/secrets/vault-extra
[ "$(cat "$X/vault-sam-github/value")" = "$classic" ] || fail "github: the classic token was not kept as an extra"
[ "$(cat "$X/max-discord/value")" = "$disc" ] && modeis "$X/max-discord/value" 600 && modeis "$X/max-discord" 700 && modeis "$X" 700 || fail "extras: value or folder modes"
[ "$(cat "$X/max-discord/meta")" = "$(printf 'kind=env\nenv=FFDISCORD_APP_TOKEN\nowner=-\nshare=anyone\nroles=workers\nmachines=lothdesktop')" ] || fail "extras: meta: $(cat "$X/max-discord/meta")"
printf '%s' "$out" | matches -F 'copied max-discord (…' || fail "extras: not logged: $out"
# the VM's own entry changes: the copy follows it (an extra has no other editor), the old one is kept as value.prev
disc2=$(rnd 60)
vm_add max-discord env "" "$disc2" FFDISCORD_APP_TOKEN anyone workers lothdesktop
out=$(pull); secret=$out; noleak "$disc2"
[ "$(cat "$X/max-discord/value")" = "$disc2" ] && [ "$(cat "$X/max-discord/value.prev")" = "$disc" ] || fail "extras: a changed value did not replace the copy and keep the old one"
printf '%s' "$out" | matches 'updated the copy of max-discord' || fail "extras: the update is not logged: $out"
# a sync never removes an extra (even one named vault-…), and a rebuilt VM gets them back, with their grants
vm_add vault-weird claude "" "$(tok)" "" anyone workers '*'
pull >/dev/null
out=$(standalone); secret=$out
[ -f "$FAKE/vault/max-discord" ] && [ -f "$FAKE/vault/vault-weird" ] && [ "$(calls removed)" = 0 ] || fail "extras: a sync removed an entry kept as an extra: $(names)"
rm -rf "$FAKE/vault" "$FAKE/values" "$FAKE/meta"; mkdir -p "$FAKE/vault"      # the VM is rebuilt: its vault is empty
out=$(standalone); secret=$out; noleak "$gh" "$classic" "$disc2"
[ "$(names)" = "max-discord vault-ben-github vault-sam-github vault-weird" ] || fail "rebuild: the vault holds $(names): $out"
[ "$(vm_value max-discord)" = "$disc2" ] && [ "$(cat "$FAKE/meta/max-discord")" = "env|FFDISCORD_APP_TOKEN||anyone|workers|lothdesktop" ] || fail "rebuild: max-discord came back as: $(cat "$FAKE/meta/max-discord")"
printf '%s' "$out" | matches -F 'restored max-discord' || fail "rebuild: not logged: $out"
# an extra the VM has is never changed from here
echo "kept" >"$FAKE/values/max-discord"
standalone >/dev/null
[ "$(cat "$FAKE/values/max-discord")" = kept ] || fail "an extra in the VM was overwritten by the restore"
ok "GitHub tokens go to github-token (classic ones are kept as extras), other kinds to vault-extra/<name>/{value,meta}; the copy follows the VM's changes, a sync keeps them, a rebuilt VM gets them back"

# ---------------------------------------------------------------- w749: the VM is the less trusted side of the copy
fresh
good=$(tok)
vm_add vault-ben-1 claude ben "$good"
fp12=$(printf %s "$good" | sha256sum | cut -c1-12)
evil=$(printf 'vault-../../x\tclaude\t-\tben\towner\tworkers\t*\t%s\tabcd\t0\n' "$fp12")
evil+=$(printf '\nvault-ben-2\tclaude\t-\t../../etc\towner\tworkers\t*\t%s\tabcd\t0' "$fp12")
evil+=$(printf '\nvault-ben-3\tclaude\t-\tben\towner\tworkers; touch /tmp/pwned\t*\t%s\tabcd\t0' "$fp12")
evil+=$(printf '\nvault-ben-4\tclaude\t-\tben\towner\tworkers\t*; id\t%s\tabcd\t0' "$fp12")
out=$(FAKE_MANIFEST_EXTRA=$evil pull); secret=$out; noleak "$good"
[ "$(find "$T/etc/secrets" -type f | sort | sed "s|$T/etc/secrets/||" | paste -sd' ' -)" = "people/ben/claude-tokens/1 vault.key" ] || fail "hostile manifest: files exist that should not: $(find "$T/etc/secrets" -type f | sort | paste -sd' ' -)"
[ ! -e "$T/etc/secrets/x" ] && [ ! -e /tmp/pwned ] || fail "hostile manifest: something outside the secrets folder was written"
[ "$(printf '%s' "$out" | grep -c 'is not shaped like a vault entry')" = 4 ] || fail "hostile manifest: the four bad lines are not each said: $out"
ok "a listing from the VM is checked before any of it becomes a path or a command: a path in a name or an owner, a command in the grants are skipped"

# ---------------------------------------------------------------- w749: the nightly's copy is in fff-vm, before the VM stops
awk '/^cmd_nightly\(\) \{/ {n = 1} n && /nightly_vault_copy$/ {c = NR} n && /prepare-shutdown/ {p = NR} END {exit !(c && p && c < p)}' "$H/fff-vm" || fail "fff-vm nightly does not copy the vault entries before it drains and stops the VM"
ok "fff-vm nightly runs the copy before the drain and the shutdown"



# ---------------------------------------------------------------- the installed scripts follow the checkout in every mode
# shellcheck source=../host/lib.sh
. "$H/lib.sh"
LIBD=$T/inst/lib
SBIN=$T/inst/sbin
mkdir -p "$LIBD" "$SBIN"
HOST_SCRIPTS_OWNER="$(id -un):$(id -gn)"
export HOST_SCRIPTS_OWNER DRY_RUN=0
# an older install: a vault.sh that predates the pool (reads claude-token only), and an old fff-vm
printf '# old vault.sh\n' >"$LIBD/vault.sh"
printf '#!/bin/sh\n# old fff-vm\n' >"$SBIN/fff-vm"
out=$(install_host_scripts "$H" "$LIBD" "$SBIN" 2>&1)
for f in lib.sh pathwatch.sh vault.sh fff-vm.conf.example; do cmp -s "$H/$f" "$LIBD/$f" || fail "install_host_scripts left an old $f"; done
cmp -s "$H/fff-vm" "$SBIN/fff-vm" || fail "install_host_scripts left an old fff-vm"
[ -x "$SBIN/fff-vm" ] || fail "fff-vm is not executable"
printf '%s' "$out" | matches 'host scripts updated: .*vault.sh' || fail "the update is not logged: $out"
out=$(install_host_scripts "$H" "$LIBD" "$SBIN" 2>&1)
[ -z "$out" ] || fail "a second call said something: $out"
# the call is in install.sh for the host part (step 10) and, before the guest part, for --guest-only
# shellcheck disable=SC2016 # the pattern is install.sh's own text, with its literal $here
[ "$(grep -c '^ *install_host_scripts "\$here"' "$H/install.sh")" = 2 ] || fail "install.sh must call install_host_scripts in the host part and for --guest-only: $(grep -n 'install_host_scripts' "$H/install.sh")"
awk '/^fi # HOST$/ {host_end = NR} /^if \[ "\$HOST" = 0 \]; then$/ && host_end && !seen {seen = 1; guest_only = NR} /^if \[ "\$GUEST" = 1 \]; then$/ && host_end {if (guest_only && guest_only < NR) ok = 1; exit} END {exit ok ? 0 : 1}' "$H/install.sh" ||
  fail "install.sh's --guest-only call is not between the host part and the guest part"
ok "install_host_scripts replaces an older vault.sh and fff-vm, changes nothing the second time, and install.sh calls it for --guest-only"
echo "all fff-vault-sync scenarios pass"
