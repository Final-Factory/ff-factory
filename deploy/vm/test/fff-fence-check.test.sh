#!/usr/bin/env bash
# `fffctl fence-check` (w5506), as the caller instead of the portal's account (FENCE_USER), or as nobody when run as root (CI); no VM:
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
  [ -z "${unit:-}" ] || systemctl stop "$unit" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
[ "$(uname -s)" = Linux ] || { echo "skip: fence-check is Linux's"; exit 0; }

oat="sk-ant-oat01-$(printf 'Q%.0s' {1..60})"
ghp="ghp_$(printf 'r%.0s' {1..36})"
printf 'a2V5LWJ5dGVzLW5vdC1hLXJlYWwta2V5LXctNTUwNg==\n' >"$tmp/vault.key"
chmod 000 "$tmp/vault.key"
# As root (CI's lint job) the probes run as nobody, who also owns the processes they look at: root opens any file.
if [ "$(id -u)" = 0 ]; then
  who=nobody
  chmod 0711 "$tmp"
  chown nobody "$tmp/vault.key"
  as_who() { exec setpriv --reuid=nobody --regid="$(id -g nobody)" --clear-groups -- "$@"; }
else
  who=$(id -un)
  as_who() { exec "$@"; }
fi
printf 'FFF_ROOT=%s\nFFF_USER=fff-no-such-user-w5506\n' "$tmp" >"$tmp/fff.conf"
# The portal: an execute-only copy of node, as fff-portal.service's ExecStartPre makes it.
cp "$(command -v node)" "$tmp/node-portal"
chmod 0111 "$tmp/node-portal"
unit=""
if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
  # As the VM starts it: systemd drops root for the unit's User= and runs the execute-only node.
  unit=fff-fence-test-$$.service
  systemd-run --quiet --collect --unit="$unit" -p User=nobody -p Group="$(id -gn nobody)" --setenv=FAKE_PORTAL_MARKER="$oat" \
    "$tmp/node-portal" -e 'setTimeout(() => {}, 60000)'
  portal=$(systemctl show -p MainPID --value "$unit")
else
  FAKE_PORTAL_MARKER=$oat as_who "$tmp/node-portal" -e 'setTimeout(() => {}, 60000)' &
  portal=$!
  pids+=("$portal")
fi
as_who env -i PATH="$PATH" CLAUDE_CODE_OAUTH_TOKEN="$oat" sleep 60 &
claude=$!
pids+=("$claude")
as_who env -i PATH="$PATH" GH_TOKEN="$ghp" sleep 60 &
gh=$!
pids+=("$gh")
sleep 0.5
echo "kernel $(uname -r), fs.suid_dumpable $(cat /proc/sys/fs/suid_dumpable), portal pid $portal ($( [ -n "$unit" ] && echo "systemd-run, User=nobody" || echo "as $who")): $(grep -E '^(Uid|NoNewPrivs)' "/proc/$portal/status" | tr -s '\t\n' '  '), environ $(stat -c '%U %a' "/proc/$portal/environ")"

# The agents' own account (w5598): as root, daemon stands in for it (another uid than the portal's nobody); otherwise none.
agent=""
[ "$(id -u)" != 0 ] || agent=daemon
ctl() { FENCE_AGENT_USER=$agent FFF_TEST_NOROOT=1 FFF_LIB=$G FFF_CONF=$tmp/fff.conf FENCE_USER=$who FENCE_KEY=$tmp/vault.key FENCE_CREDENTIALS=$tmp/no-credentials FENCE_PORTAL_PID=$portal bash $G/fffctl fence-check "$@" 2>&1; }
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
if [ -n "$agent" ]; then
  printf '%s' "$out" | matches -x "== as $agent, the portal's agents' account (w5598), outside the portal's process tree" || fail "no agent section: $out"
  printf '%s' "$out" | sed -n "/^== as $agent/,\$p" >"$tmp/agent.out"
  matches -E "^refused: the vault key \\($tmp/vault.key\\): Permission denied" "$tmp/agent.out" || fail "the key is not refused to the agents' account: $(cat "$tmp/agent.out")"
  for p in environ mem fd; do matches -E "^refused: the portal's $p " "$tmp/agent.out" || fail "the portal's $p is not refused to the agents' account: $(cat "$tmp/agent.out")"; done
  matches -E "^a stand-in for the portal's git and gh: pid [0-9]+, as nobody; nobody itself opens its environ$" "$tmp/agent.out" || fail "the stand-in git child is not open to its own account, so the probe proves nothing: $(cat "$tmp/agent.out")"
  matches -E "^refused: the stand-in git or gh child's environ \\(/proc/[0-9]+/environ\\): Permission denied" "$tmp/agent.out" || fail "the stand-in git child's environ is not refused to the agents' account: $(cat "$tmp/agent.out")"
  matches -x "processes of nobody: 2 environs refused to $agent" "$tmp/agent.out" || fail "the portal account's processes are not all refused to the agents' account: $(cat "$tmp/agent.out")"
  ! matches '^OPENED' "$tmp/agent.out" || fail "something is open to the agents' account: $(cat "$tmp/agent.out")"
  echo "ok: as the agents' account the key, the portal's environ, mem and fd, a running git stand-in's environ and every process of the portal's account are refused"
else
  printf '%s' "$out" | matches -F "absent: the agents' own account" || fail "no agents' account is not named absent: $out"
  echo "skip: the agents' account probes need root (CI runs them)"
fi

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
