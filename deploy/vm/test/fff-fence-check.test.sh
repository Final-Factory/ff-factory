#!/usr/bin/env bash
# `fffctl fence-check` (w5506), unprivileged, as the caller instead of the portal's account (FENCE_USER); no root and no VM:
# run by lint.sh. What it checks:
#   a key file the account may not open is "refused", one it may is "OPENED" and fails the check;
#   a process running an execute-only node (deploy/vm/guest/units/fff-portal.service's node-portal) is not dumpable: its
#   environ, mem and fd are refused to the same account;
#   a process with a Claude token in its environment fails the check, one with only a GitHub token is named and passes;
#   no value it read is printed, and it takes no option.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT
[ "$(uname -s)" = Linux ] || { echo "skip: fence-check is Linux's"; exit 0; }

oat="sk-ant-oat01-$(printf 'Q%.0s' {1..60})"
ghp="ghp_$(printf 'r%.0s' {1..36})"
printf 'a2V5LWJ5dGVzLW5vdC1hLXJlYWwta2V5LXctNTUwNg==\n' >"$tmp/vault.key"
chmod 000 "$tmp/vault.key"
printf 'FFF_ROOT=%s\nFFF_USER=fff-no-such-user-w5506\n' "$tmp" >"$tmp/fff.conf"
# The portal: an execute-only copy of node, as fff-portal.service's ExecStartPre makes it.
cp "$(command -v node)" "$tmp/node-portal"
chmod 0111 "$tmp/node-portal"
FAKE_PORTAL_MARKER=$oat "$tmp/node-portal" -e 'setTimeout(() => {}, 60000)' &
portal=$!
pids+=("$portal")
env -i PATH="$PATH" CLAUDE_CODE_OAUTH_TOKEN="$oat" sleep 60 &
claude=$!
pids+=("$claude")
env -i PATH="$PATH" GH_TOKEN="$ghp" sleep 60 &
gh=$!
pids+=("$gh")
sleep 0.5

ctl() { FFF_TEST_NOROOT=1 FFF_LIB=$G FFF_CONF=$tmp/fff.conf FENCE_USER=$(id -un) FENCE_KEY=$tmp/vault.key FENCE_CREDENTIALS=$tmp/no-credentials FENCE_PORTAL_PID=$portal bash $G/fffctl fence-check "$@" 2>&1; }
noval() { if printf '%s' "$1" | matches -e "$oat" -e "$ghp" -e 'a2V5LWJ5'; then fail "fence-check printed a value: $1"; fi; }

rc=0
out=$(FENCE_PIDS="$claude $gh" ctl) || rc=$?
echo "$out"
noval "$out"
[ "$rc" = 1 ] || fail "a Claude token in an environment did not fail the check (exit $rc)"
printf '%s' "$out" | matches -E "^refused: the vault key \\($tmp/vault.key\\): Permission denied" || fail "the key file the account may not open is not refused: $out"
printf '%s' "$out" | matches -F "absent: systemd's credentials folder" || fail "the missing credentials folder is not named absent: $out"
if [ "$(cat /proc/sys/fs/suid_dumpable)" = 1 ]; then
  echo "skip: fs.suid_dumpable is 1 here, which keeps an execute-only binary's process dumpable (the VM's is 0 or 2; ci-vm-e2e.sh checks it)"
else
  for p in environ mem fd; do printf '%s' "$out" | matches -E "^refused: the portal's $p \\(/proc/$portal/$p\\)" || fail "the execute-only portal's $p is not refused: $out"; done
fi
printf '%s' "$out" | matches -E "^process $claude \\(sleep\\): CREDENTIAL IN ITS ENVIRONMENT: CLAUDE_CODE_OAUTH_TOKEN$" || fail "the Claude token's process is not named: $out"
printf '%s' "$out" | matches -E "^process $gh \\(sleep\\): holds GH_TOKEN in its environment" || fail "the GitHub token's process is not named: $out"
printf '%s' "$out" | matches -x 'fence: OPEN' || fail "no verdict: $out"
echo "ok: a Claude token in a process's environment fails the check; the key and the execute-only portal are refused; no value shows"

rc=0
out=$(FENCE_PIDS="$gh" ctl) || rc=$?
noval "$out"
if [ "$(cat /proc/sys/fs/suid_dumpable)" != 1 ]; then
  [ "$rc" = 0 ] || fail "a fenced portal and a GitHub token only did not pass (exit $rc): $out"
  printf '%s' "$out" | matches -x 'fence: holds' || fail "no verdict: $out"
fi
chmod 600 "$tmp/vault.key"
rc=0
out=$(FENCE_PIDS="" ctl) || rc=$?
noval "$out"
[ "$rc" = 1 ] || fail "a key the account may open did not fail the check (exit $rc): $out"
printf '%s' "$out" | matches -F "OPENED: the vault key ($tmp/vault.key)" || fail "an open key is not named: $out"
echo "ok: with only a GitHub token it holds; a key the account may open fails it"

rc=0
out=$(ctl extra) || rc=$?
[ "$rc" != 0 ] || fail "fence-check took an option: $out"
echo "ok: fence-check takes no option"
echo "all fence-check checks pass"
