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
case "$cmd" in
  'sudo fffctl vault list --names') ls "$V" ;;
  'sudo fffctl vault put '*)
    name=$(sed -E 's/.*--name ([^ ]+).*/\1/' <<<"$cmd")
    owner=$(sed -E 's/.*--owner ([^ ]+).*/\1/' <<<"$cmd")
    new=$(sha256sum | cut -d' ' -f1)
    want="$owner|$new"
    # the portal's rename (w748): no entry of this name, a host-… one holding this very token: it takes the new name
    if [ ! -f "$V/$name" ] && [ "${name#vault-}" != "$name" ]; then
      for old in "$V"/host-*; do
        [ -f "$old" ] || continue
        if [ "$(cut -d'|' -f2 "$old")" = "$new" ] && [ -z "${FAKE_OLD_PORTAL:-}" ]; then mv "$old" "$V/$name"; echo "renamed: $name (was $(basename "$old"))"; echo "renamed $name" >>"$FAKE/calls"; exit 0; fi
        if [ "$(cut -d'|' -f2 "$old")" = "$new" ]; then echo "vault: that value is already in the vault as $(basename "$old")" >&2; exit 1; fi
      done
    fi
    if [ -f "$V/$name" ]; then
      if [ "$(cat "$V/$name")" = "$want" ]; then echo "unchanged: $name"; else echo "$want" >"$V/$name"; echo "rotated: $name"; fi
    else
      echo "$want" >"$V/$name"
      echo "added: $name"
    fi
    echo "put $name" >>"$FAKE/calls" ;;
  'sudo fffctl vault remove '*) name=${cmd##* }; rm -f "$V/$name"; echo "removed $name" >>"$FAKE/calls"; echo "removed $name" ;;
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

rnd() { local s; s=$(head -c 96 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }
tok() { printf 'sk-ant-oat01-%s' "$(rnd 44)"; }
put() { # PERSON RELATIVE-PATH VALUE
  mkdir -p "$T/etc/secrets/people/$1/$(dirname "$2")"
  printf '%s\n' "$3" >"$T/etc/secrets/people/$1/$2"
  chmod 0600 "$T/etc/secrets/people/$1/$2"
}
fresh() { rm -rf "$T/etc/secrets/people" "$FAKE/vault" "$FAKE/calls"; mkdir -p "$T/etc/secrets/people" "$FAKE/vault"; chmod 0700 "$T/etc/secrets/people"; : >"$FAKE/calls"; }
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
echo "sam|y" >"$FAKE/vault/vault-gone"      # a vault-* entry whose file does not exist
out=$(standalone); secret=$out
[ -f "$FAKE/vault/vault-gone" ] && fail "an entry with no file stayed: $out"
printf '%s' "$out" | matches -F 'removed vault-gone' || fail "the removal is not logged: $out"
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
