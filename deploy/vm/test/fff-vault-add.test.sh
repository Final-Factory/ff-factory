#!/usr/bin/env bash
# the fake node below is single-quoted on purpose: it reads its variables when it runs
# shellcheck disable=SC2016
# `sudo fffctl vault add-claude PERSON [NAME]` in the VM (w749, deploy/vm/guest/fffctl): the real fffctl against a fake node that
# stands in for server/vaultCli.ts. No root, no VM, run by lint.sh. What it checks:
#   - the token comes from stdin (the hidden prompt is the same read on a terminal) and never from the command line: no argument
#     of the node call, and none of fffctl's own messages, carries it;
#   - the entry is vault-<person>-<n>, the next free number (one taken by vault-… or by a host-<person>-claude-<n> that is still to
#     be renamed counts), or the NAME given, in lower case; it is the person's own (share owner, workers and standing, every machine);
#   - a name that exists, a NAME or PERSON that is no name, a token that is not sk-ant-oat01-…, and a third argument that would be
#     a token typed on the command line are refused with nothing added and nothing of the value shown;
#   - a person with no entry before is said, so a mistyped user id is noticed.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=$PWD/deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ROOT=$tmp/srv
mkdir -p "$ROOT/data" "$ROOT/config" "$ROOT/app/current/server" "$tmp/bin" "$tmp/vault"
: >"$ROOT/app/current/server/vaultCli.ts"
printf 'FFF_ROOT=%s\nFFF_USER=%s\n' "$ROOT" "$(id -un)" >"$tmp/fff.conf"
# node, as `node server/vaultCli.ts …` is called: list --names, and add (the value on stdin); every call's arguments are kept.
cat >"$tmp/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE/argv"
[ "$1" = server/vaultCli.ts ] || { echo "fake node: $*" >&2; exit 1; }
shift
V=$FAKE/vault
case "$1" in
  list) ls "$V" ;;
  add)
    name=$(sed -E 's/.*--name ([^ ]+).*/\1/' <<<"$*")
    [ ! -f "$V/$name" ] || { echo "vault: a vault entry named $name exists; rotate it instead" >&2; exit 2; }
    cat >"$V/$name"
    echo "$*" >"$FAKE/add-$name.args"
    echo "added: $name" ;;
  *) echo "fake node: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/node"
export FAKE=$tmp FFF_CONF=$tmp/fff.conf FFF_LIB=$G FFF_TEST_NOROOT=1 FFF_PATH_PREFIX=$tmp/bin

rnd() { local s; s=$(head -c 96 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }
tok() { printf 'sk-ant-oat01-%s' "$(rnd 44)"; }
fresh() { rm -rf "$tmp/vault" "$tmp"/add-*.args "$tmp/argv"; mkdir -p "$tmp/vault"; : >"$tmp/argv"; }
names() { find "$tmp/vault" -type f -printf '%f\n' | sort | paste -sd' ' -; }
# add PERSON [NAME] with the token on stdin: output in $out, exit code in $rc
add() { # TOKEN PERSON [NAME...]
  local t=$1
  shift
  rc=0
  out=$(printf '%s\n' "$t" | bash "$G/fffctl" vault add-claude "$@" 2>&1) || rc=$?
}
noleak() { local v; for v in "$@"; do if printf '%s' "$out" | matches -F "${v:13:30}"; then fail "a token value reached the output: $out"; fi; if matches -F "${v:13:30}" "$tmp/argv"; then fail "a token value was an argument of node"; fi; done; }

# ---------------------------------------------------------------- the next free number, the person's own entry
fresh
t1=$(tok); t2=$(tok); t3=$(tok)
add "$t1" ben; noleak "$t1"
[ "$rc" = 0 ] && [ "$(names)" = "vault-ben-1" ] || fail "first add: rc $rc, vault: $(names): $out"
[ "$(cat "$tmp/vault/vault-ben-1")" = "$t1" ] || fail "first add: the entry does not hold the token that was piped in"
add "$t2" ben; noleak "$t2"
[ "$(names)" = "vault-ben-1 vault-ben-2" ] || fail "second add: $(names): $out"
printf '%s' "$out" | matches -F 'sudo fff-vm vault-pull' || fail "the next step (the host's copy) is not said: $out"
# the grants: the person's own, workers and standing, every machine
for want in '--kind claude' '--owner ben' '--share owner' '--roles workers,standing' "--machines *" '--stdin'; do
  grep -qF -e "$want" "$tmp/add-vault-ben-2.args" || fail "the add call lacks '$want': $(cat "$tmp/add-vault-ben-2.args")"
done
# a taken number is skipped, a vault-… one and a host-… one the host still has to rename alike
rm -f "$tmp/vault/vault-ben-1"; : >"$tmp/vault/host-ben-claude-1"; : >"$tmp/vault/vault-ben-3"
add "$t3" ben; noleak "$t3"
[ "$(names)" = "host-ben-claude-1 vault-ben-2 vault-ben-3 vault-ben-4" ] || fail "numbering: $(names): $out"
ok "stdin token into vault-<person>-<n>, the next free number (host-… ones to be renamed count), the person's own, never an argument"

# ---------------------------------------------------------------- a given name, in lower case; a case-mixed person
fresh
t1=$(tok)
add "$t1" Ben Second; noleak "$t1"
[ "$(names)" = "vault-ben-second" ] || fail "named: $(names): $out"
grep -qF -e '--owner Ben' "$tmp/add-vault-ben-second.args" || fail "the owner is the person as typed (the portal compares them without case): $(cat "$tmp/add-vault-ben-second.args")"
printf '%s' "$out" | matches -F "nobody had a vault entry for 'Ben'" || fail "a person with no entry before is not said: $out"
t2=$(tok)
add "$t2" ben 2; noleak "$t2"
printf '%s' "$out" | matches -F 'nobody had' && fail "a person who has entries was told nobody had: $out"
ok "a given name is lower-cased; a person without entries before is said"

# ---------------------------------------------------------------- refused: nothing added, nothing of the value shown
fresh
t1=$(tok)
add "$t1" ben a; [ "$rc" = 0 ] || fail "setup: $out"
add "$(tok)" ben a; noleak
[ "$rc" != 0 ] || fail "an existing name was not refused: rc $rc: $out"
printf '%s' "$out" | matches 'vault-ben-a exists' || fail "an existing name was not refused: rc $rc: $out"
printf '%s' "$out" | matches -F 'host' || fail "the refusal does not say the host's file wins: $out"
[ "$(cat "$tmp/vault/vault-ben-a")" = "$t1" ] || fail "an existing entry was changed"
bad=$(tok)'!'
add "$bad" ben b; noleak "$bad"
[ "$rc" != 0 ] && [ "$(names)" = "vault-ben-a" ] || fail "a token with a bad character was added: $(names): $out"
add "$(printf 'not a token at all %s' "$(rnd 20)")" ben b
[ "$rc" != 0 ] && [ "$(names)" = "vault-ben-a" ] || fail "a non-token was added or not named: $(names): $out"
printf '%s' "$out" | matches 'not one Claude token' || fail "a non-token was added or not named: $(names): $out"
if printf '%s' "$out" | matches 'at all'; then fail "the bad content was printed: $out"; fi
add "" ben b
[ "$rc" != 0 ] && [ "$(names)" = "vault-ben-a" ] || fail "an empty token was added"
t2=$(tok)
add "$t2" ben 'a b'; noleak "$t2"
[ "$rc" != 0 ] || fail "a NAME with a space was not refused: $out"
printf '%s' "$out" | matches 'NAME is 1 to 16' || fail "a NAME with a space was not refused: $out"
add "$t2" 'be n'; noleak "$t2"
[ "$rc" != 0 ] || fail "a PERSON with a space was not refused: $out"
printf '%s' "$out" | matches 'PERSON is a portal user id' || fail "a PERSON with a space was not refused: $out"
# a token typed as the NAME, or as a third word: refused, and not echoed
add "$t2" ben "$t2"; noleak "$t2"
[ "$rc" != 0 ] || fail "a token as the NAME was accepted"
add "$t2" ben b "$t2"; noleak "$t2"
[ "$rc" != 0 ] || fail "a third word (a token on the command line) was not refused with that reason: $out"
printf '%s' "$out" | matches -F 'never an argument' || fail "a third word (a token on the command line) was not refused with that reason: $out"
add "$t2"; [ "$rc" != 0 ] || fail "no PERSON was accepted"
[ "$(names)" = "vault-ben-a" ] || fail "something was added by a refused call: $(names)"
ok "an existing name, a bad token, an empty one, a bad NAME or PERSON, and a token typed as an argument are refused; nothing added, nothing shown"

# ---------------------------------------------------------------- w785: the account email, recorded by a person, never read from the token
fresh
t4=$(tok)
add "$t4" ben --email ben@example.com; noleak "$t4"
[ "$rc" = 0 ] || fail "add-claude with --email failed: $out"
matches -F -e '--email ben@example.com' "$tmp/add-vault-ben-1.args" || fail "the email did not reach vaultCli add: $(cat "$tmp/add-vault-ben-1.args")"
add "$(tok)" ben second; [ "$rc" = 0 ] || fail "add without an email failed: $out"
if matches -F -e '--email' "$tmp/add-vault-ben-second.args"; then fail "an email was invented when none was given"; fi
add "$(tok)" ben third --email=Ben.Two@Example.com; [ "$rc" = 0 ] || fail "--email=ADDRESS form failed: $out"
matches -F -e '--email Ben.Two@Example.com' "$tmp/add-vault-ben-third.args" || fail "the --email= form did not reach vaultCli add"
before=$(names)
add "$(tok)" ben fourth --email 'not an address'; [ "$rc" != 0 ] || fail "a bad email was accepted"
printf '%s' "$out" | matches 'is not one address' || fail "a bad email gave no reason: $out"
[ "$(names)" = "$before" ] || fail "a refused email still added an entry"
add "$(tok)" ben fifth --email; [ "$rc" != 0 ] || fail "--email with no address was accepted"
ok "--email is passed to vaultCli add, none is invented without it, a bad address is refused before anything is added"

# ---------------------------------------------------------------- the prompt is a hidden read, and nothing else reads the value
# shellcheck disable=SC2016
grep -q 'read -rs -p "Claude token for' "$G/fffctl" || fail "the terminal prompt must be 'read -rs' (no echo)"
if sed -n '/^vault_add_claude()/,/^}/p' "$G/fffctl" | grep -n 'echo "\$t"\|printf .*\$t.*>&2\|set -x' >/dev/null; then fail "vault_add_claude prints the token"; fi
ok "the terminal prompt reads without echo, and the function never prints the token"
# `fffctl vault help` prints vaultCli.ts's usage header, now longer (the e2e's ops-worker step runs it; a bad sed range broke it)
cp server/vaultCli.ts "$ROOT/app/current/server/vaultCli.ts"
out=$(bash "$G/fffctl" vault help 2>&1) || fail "vault help failed: $out"
printf '%s' "$out" | matches -F 'export --manifest' || fail "vault help does not show the export form: $out"
printf '%s' "$out" | matches -F 'The key: ' || fail "vault help stops before the end of the header: $out"
ok "fffctl vault help prints the whole usage header"
echo "all fff-vault-add scenarios pass"
