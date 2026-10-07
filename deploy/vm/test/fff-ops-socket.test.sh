#!/usr/bin/env bash
# The orchestration worker's socket under real systemd (w638, docs/ops-worker.md): fff-ops.socket's own [Socket]
# settings (Accept=yes, MaxConnections=1), a template service running the real fff-ops-launch with a fake claude, and
# the portal's real opsSpawner (fff-ops-socket.driver.ts) as the account the socket belongs to. It checks that systemd
# drops a second connection while one is open, which is what crashed fresh jobs on 2026-10-07, and that a new process
# started right after a stop runs, whether the last one was idle or mid-turn.
# Needs root, systemd, jq and node with the repository's node_modules: CI runs it on a throwaway runner
# (.github/workflows/ci.yml); run it by hand only on a throwaway machine: sudo --preserve-env=PATH deploy/vm/test/fff-ops-socket.test.sh
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
fail() { echo "FAIL: $*"; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root (sudo), on a throwaway machine"
user=${SUDO_USER:?run it with sudo, as the account that will connect}
group=$(id -gn "$user")
unit=fff-ops-w638-test
tmp=$(mktemp -d)
chmod 0755 "$tmp"
cleanup() {
  systemctl stop "$unit.socket" 2>/dev/null || true
  rm -f "/run/systemd/system/$unit.socket" "/run/systemd/system/$unit@.service"
  systemctl daemon-reload
  rm -rf "$tmp"
}
trap cleanup EXIT

# The fake claude: hello, then a line per message; "slow" opens a turn that only an interrupt ends. When its input
# ends with a turn open, the turn runs on (20 s), as stream-json reads no more after the end; then it takes 0.5 s to exit.
lib=$tmp/lib
mkdir -p "$lib" "$tmp/ops"
cat >"$lib/claude" <<'EOF'
#!/bin/bash
echo "{\"type\":\"hello\",\"pid\":$$}"
busy=0
while IFS= read -r line; do
  case $line in
    *'"subtype":"interrupt"'*) busy=0; echo '{"type":"interrupted"}' ;;
    *slow*) busy=1; echo '{"type":"busy"}' ;;
    *) echo '{"type":"echo"}' ;;
  esac
done
[ "$busy" = 0 ] || sleep 20
sleep 0.5
EOF
chmod 0755 "$lib/claude"
version=9.9.9-ci
echo "$version" >"$lib/claude.version"
chown -R "$user:$group" "$tmp/ops"

# fff-ops.socket as shipped, but its path, its owner (the account running the driver) and no scratch dependency.
sed -e "s|^ListenStream=.*|ListenStream=$tmp/claude.sock|" -e "s|^SocketUser=.*|SocketUser=$user|" -e "s|^SocketGroup=.*|SocketGroup=$group|" \
  -e '/^Requires=/d' -e '/^After=/d' -e '/^DirectoryMode=/d' -e '/^\[Install\]/,$d' deploy/vm/guest/units/fff-ops.socket >"/run/systemd/system/$unit.socket"
grep -qx 'Accept=yes' "/run/systemd/system/$unit.socket" || fail "fff-ops.socket no longer has Accept=yes: update this test"
grep -qx 'MaxConnections=1' "/run/systemd/system/$unit.socket" || fail "fff-ops.socket no longer has MaxConnections=1: update this test"
cat >"/run/systemd/system/$unit@.service" <<EOF
[Service]
Type=simple
User=$user
Group=$group
ExecStart=$PWD/deploy/vm/guest/fff-ops-launch
Environment=OPS_LIB=$lib OPS_ROOT=$tmp/ops
StandardInput=socket
StandardOutput=socket
StandardError=journal
SyslogIdentifier=$unit
EOF
systemctl daemon-reload
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl start "$unit.socket"

status=0
sudo -u "$user" env PATH="$PATH" node deploy/vm/test/fff-ops-socket.driver.ts "$tmp/claude.sock" "$version" || status=$?
sleep 1
echo "--- systemd's journal for the socket and its services"
journalctl --no-pager -o short-precise --since "$since" -u "$unit.socket" -t "$unit" | grep -Ev 'Listening on|Closed|Stopped|Deactivated' || true
drops=$(journalctl --no-pager --since "$since" -u "$unit.socket" | grep -c 'Too many incoming connections' || true)
echo "systemd dropped $drops connection(s) for MaxConnections=1"
[ "$drops" -ge 1 ] || fail "systemd never logged a dropped connection: the mechanism check did not reach it"
[ "$status" = 0 ] || fail "the driver failed (above)"
echo "fff-ops-socket.test.sh: pass"
