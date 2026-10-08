#!/usr/bin/env bash
# the fakes written below are single-quoted on purpose: they read their variables when they run
# shellcheck disable=SC2016
# The portal VM's unit watchdog (w698, deploy/vm/guest/fff-watchdog), against a fake systemctl: no root, no VM, run by
# lint.sh. What it checks, one scenario each:
#   a failed unit, and the 2026-10-08 case (fff-ops.socket inactive (dead)), is restarted, logged and recorded: which unit,
#   when, why; a unit active without doing its job (no nftables table, no mount, no socket file) is restarted; a disabled
#   unit is enabled; the back-off doubles and is capped; after WATCHDOG_MAX_ATTEMPTS restarts it gives up, tells the
#   dispatcher once and stops; a unit that held for WATCHDOG_HEALTHY_SEC starts over; nothing is touched while the VM shuts
#   down, a unit has a job, the watchdog is paused, or the portal is held; the portal restarts without waiting; a unit whose
#   file is missing or that is masked is reported, not restarted; fffctl units shows it all.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=$PWD/deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }
[ "$(id -gn)" = "$(id -un)" ] || { echo "skipped: the guest scripts chown to user:user and this account's group is $(id -gn)"; exit 0; }
command -v jq >/dev/null || fail "jq is needed"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export FAKE=$tmp/fake RUNDIR=$tmp/run
ROOT=$tmp/srv
mkdir -p "$FAKE" "$RUNDIR" "$ROOT/data" "$ROOT/config" "$tmp/bin"
cat >"$tmp/fff.conf" <<EOF
FFF_ROOT=$ROOT
FFF_USER=$(id -un)
OPS_ROOT=$tmp/ops
EOF
cat >"$tmp/bin/systemctl" <<'EOF'
#!/bin/bash
f=$FAKE
echo "$*" >>"$f/calls"
cmd=$1; shift
case $cmd in
  show)
    props=(); value=0; unit=""
    while [ $# -gt 0 ]; do
      case $1 in -p) props+=("$2"); shift ;; --value) value=1 ;; *) unit=$1 ;; esac
      shift
    done
    if [ ! -f "$f/$unit" ]; then
      if [ "$value" = 1 ]; then echo; else printf 'ActiveState=inactive\nSubState=dead\nLoadState=not-found\n'; fi
      exit 0
    fi
    for p in "${props[@]}"; do
      v=$(sed -n "s/^$p=//p" "$f/$unit")
      if [ "$value" = 1 ]; then echo "$v"; else echo "$p=$v"; fi
    done ;;
  enable)
    [ "${FAKE_ENABLE_RC:-0}" != 0 ] || sed -i 's/^UnitFileState=.*/UnitFileState=enabled/' "$f/$1"
    exit "${FAKE_ENABLE_RC:-0}" ;;
  restart)
    [ "$1" != --no-block ] || shift
    if grep -qx "$1" "$f/fixes" 2>/dev/null; then sed -i 's/^ActiveState=.*/ActiveState=active/;s/^SubState=.*/SubState=running/' "$f/$1"; fi
    exit "${FAKE_RESTART_RC:-0}" ;;
  reset-failed) exit 0 ;;
  is-system-running) cat "$f/system-state" 2>/dev/null || echo running ;;
  list-jobs) cat "$f/jobs" 2>/dev/null || true ;;
  *) echo "fake systemctl: $cmd" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/systemctl"
printf '#!/bin/sh\nexit "${FAKE_NFT_RC:-0}"\n' >"$tmp/bin/nft"
printf '#!/bin/sh\nexit "${FAKE_MOUNT_RC:-0}"\n' >"$tmp/bin/mountpoint"
chmod +x "$tmp/bin/nft" "$tmp/bin/mountpoint"

export FFF_SYSTEMCTL=$tmp/bin/systemctl FFF_NFT=$tmp/bin/nft FFF_MOUNTPOINT=$tmp/bin/mountpoint FFF_RUN_DIR=$RUNDIR
export FFF_CONF=$tmp/fff.conf FFF_LIB=$G FFF_TEST_NOROOT=1 FFF_OPS_SOCKET=$tmp/claude.sock
export WATCHDOG_BACKOFF_SEC=30
START=1760000000
UNITS=$(bash -c ". $G/lib.sh; printf '%s\n' \"\${FFF_CRITICAL_UNITS[@]}\"")
[ "$(wc -l <<<"$UNITS")" -ge 8 ] || fail "lib.sh lists too few critical units: $UNITS"
# A socket file for the socket's probe (-S): a real listening unix socket, from node (the repository needs it anyway).
command -v node >/dev/null || fail "node is needed"
node -e 'require("net").createServer().listen(process.argv[1]); setInterval(() => {}, 1e6)' "$tmp/claude.sock" &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [ -S "$tmp/claude.sock" ] && break; sleep 0.1; done
[ -S "$tmp/claude.sock" ] || fail "node did not make the test socket"

mkunit() { # UNIT ACTIVE UNITFILESTATE [RESULT] [SINCE]
  local sub=running
  case $2 in inactive) sub=dead ;; failed) sub=failed ;; esac
  printf 'ActiveState=%s\nSubState=%s\nResult=%s\nLoadState=loaded\nUnitFileState=%s\nInactiveEnterTimestamp=%s\nExecMainStatus=0\n' \
    "$2" "$sub" "${4:-success}" "$3" "${5:-}" >"$FAKE/$1"
}
allgood() { local u; for u in $UNITS; do mkunit "$u" active enabled; done; : >"$FAKE/calls"; rm -f "$FAKE/fixes" "$FAKE/jobs" "$FAKE/system-state"; }
run() { # NOW: one pass of the watchdog at that time
  FFF_NOW=$1 bash "$G/fff-watchdog" 2>"$tmp/err" || { cat "$tmp/err"; fail "fff-watchdog exited $?"; }
}
restarts() { { grep -c "^restart .*$1\$" "$FAKE/calls" || true; } | head -n 1; }
state_of() { jq -r --arg u "$1" '.units[] | select(.unit == $u) | .state' "$ROOT/data/unit-watchdog.json"; }
field() { local c=-r; if [ "$1" = -c ]; then c=-c; shift; fi; jq "$c" "$1" "$ROOT/data/unit-watchdog.json"; }
fresh() { rm -rf "${RUNDIR:?}"/* "$ROOT/data/unit-watchdog.json" "$ROOT/data/orchestrator-inbox"; mkdir -p "$RUNDIR"; allgood; }

# ---------------------------------------------------------------- healthy
fresh
run $START
[ ! -s "$FAKE/calls" ] || [ "$(grep -vc '^show\|^is-system-running\|^list-jobs' "$FAKE/calls")" = 0 ] || fail "healthy: it acted: $(grep -v '^show\|^is-system-running\|^list-jobs' "$FAKE/calls")"
[ "$(field '.units | length')" = "$(wc -l <<<"$UNITS")" ] || fail "healthy: the file lists $(field '.units | length') units"
[ "$(field '[.units[] | select(.state != "ok")] | length')" = 0 ] || fail "healthy: a unit is not ok: $(field -c '.units')"
{ [ "$(field '.events | length')" = 0 ] && [ "$(field .schema)" = 1 ]; } || fail "healthy: events or schema"
ok "healthy: nothing restarted; $(field '.units | length') units listed, all ok"

# ---------------------------------------------------------------- the 2026-10-08 case: the socket is inactive (dead)
fresh
mkunit fff-ops.socket inactive enabled success "Thu 2026-10-08 15:33:02 UTC"
echo fff-ops.socket >"$FAKE/fixes"
run $START
[ "$(restarts fff-ops.socket)" = 1 ] || fail "socket: restarted $(restarts fff-ops.socket) times: $(cat "$FAKE/calls")"
[ "$(field '.events | length')" = 1 ] || fail "socket: events: $(field -c .events)"
{ [ "$(field '.events[0].unit')" = fff-ops.socket ] && [ "$(field '.events[0].action')" = restart ] && [ "$(field '.events[0].attempt')" = 1 ] && [ "$(field '.events[0].ok')" = true ]; } || fail "socket: the event is wrong: $(field -c '.events[0]')"
field '.events[0].why' | matches -F 'inactive (dead) since Thu 2026-10-08 15:33:02 UTC' || fail "socket: the reason is not in the event: $(field '.events[0].why')"
[ "$(field '.events[0].at')" = "$(date -u -d "@$START" +%FT%TZ)" ] || fail "socket: when: $(field '.events[0].at')"
matches -F "watchdog: restarted fff-ops.socket (restart 1 of 6" "$tmp/err" || fail "socket: not logged: $(cat "$tmp/err")"
{ [ "$(state_of fff-ops.socket)" = ok ] && [ "$(jq -r .nextAt "$RUNDIR/watchdog/fff-ops.socket.json")" = $((START + 30)) ]; } || fail "socket: back up, so ok, with the next restart not before +30 s: $(field -c '.units[] | select(.unit == "fff-ops.socket")')"
ok "an inactive (dead) fff-ops.socket is restarted, logged and recorded: unit, time, reason, next try"

# ---------------------------------------------------------------- back-off, give-up, no further restarts
mkunit fff-ops.socket inactive enabled success "Thu 2026-10-08 15:33:02 UTC"
rm -f "$FAKE/fixes"
run $((START + 10))
[ "$(restarts fff-ops.socket)" = 1 ] || fail "backoff: restarted again after 10 s"
[ "$(state_of fff-ops.socket)" = backoff ] || fail "backoff: state $(state_of fff-ops.socket)"
t=$((START + 30))
for n in 2 3 4 5 6; do
  run $t
  [ "$(restarts fff-ops.socket)" = "$n" ] || fail "restart $n: restarted $(restarts fff-ops.socket) times"
  delay=$((30 * (1 << (n - 1)))); [ "$delay" -le 900 ] || delay=900
  [ "$(field '.units[] | select(.unit == "fff-ops.socket") | .nextTryAt')" = "$(date -u -d "@$((t + delay))" +%FT%TZ)" ] || fail "restart $n: the next try is not $delay s later: $(field -c '.units[] | select(.unit == "fff-ops.socket")')"
  t=$((t + delay))
done
[ "$(field '.events | length')" = 6 ] || fail "6 restarts: $(field '.events | length') events"
[ "$(field '.events[5].attempt')" = 6 ] || fail "the last attempt: $(field '.events[5].attempt')"
run $((t - 1))
{ [ "$(restarts fff-ops.socket)" = 6 ] && [ "$(state_of fff-ops.socket)" = backoff ]; } || fail "after the 6th restart it must wait out the back-off before giving up"
run $t
[ "$(state_of fff-ops.socket)" = gave-up ] || fail "no give-up after 6 restarts: $(state_of fff-ops.socket)"
[ "$(restarts fff-ops.socket)" = 6 ] || fail "gave up but restarted again"
[ "$(field '.events[-1].action')" = gave-up ] || fail "no gave-up event: $(field -c '.events[-1]')"
n=$(find "$ROOT/data/orchestrator-inbox" -name '*.txt' | wc -l)
[ "$n" = 1 ] || fail "the dispatcher must hear once, heard $n"
grep -h . "$ROOT"/data/orchestrator-inbox/*.txt | matches -F 'gave up on fff-ops.socket' || fail "the dispatcher's note"
run $((t + 60)); run $((t + 120))
{ [ "$(restarts fff-ops.socket)" = 6 ] && [ "$(find "$ROOT/data/orchestrator-inbox" -name '*.txt' | wc -l)" = 1 ] && [ "$(field '[.events[] | select(.action == "gave-up")] | length')" = 1 ]; } || fail "gave-up is repeated"
ok "back-off doubles (30 s, 60 s, ...), 6 restarts that do not hold end in one gave-up event and one note to the dispatcher, then nothing more"

# ---------------------------------------------------------------- recovery and the healthy window
mkunit fff-ops.socket active enabled
run $((t + 200))
{ [ "$(state_of fff-ops.socket)" = ok ] && [ "$(jq -r .attempts "$RUNDIR/watchdog/fff-ops.socket.json")" = 6 ]; } || fail "recovered: the count must stay until it has held for WATCHDOG_HEALTHY_SEC"
run $((t + 200 + 599))
[ "$(jq -r .attempts "$RUNDIR/watchdog/fff-ops.socket.json")" = 6 ] || fail "recovered: reset too early"
run $((t + 200 + 600))
[ "$(jq -r .attempts "$RUNDIR/watchdog/fff-ops.socket.json")" = 0 ] || fail "recovered: the count did not start over after 600 s"
mkunit fff-ops.socket inactive enabled
echo fff-ops.socket >"$FAKE/fixes"
run $((t + 1000))
{ [ "$(restarts fff-ops.socket)" = 7 ] && [ "$(field '.events[-1].attempt')" = 1 ]; } || fail "a new failure after the window must restart at once, as attempt 1: $(field -c '.events[-1]')"
ok "a unit that holds 600 s starts over; the next failure is restarted at once as attempt 1"

# ---------------------------------------------------------------- failed units: the portal restarts without waiting
fresh
mkunit fff-portal.service failed enabled exit-code
echo fff-portal.service >"$FAKE/fixes"
run $START
grep -qx 'restart --no-block fff-portal.service' "$FAKE/calls" || fail "portal: not restarted with --no-block: $(cat "$FAKE/calls")"
field '.events[0].why' | matches -F 'failed (Result=exit-code' || fail "portal: reason: $(field '.events[0].why')"
mkunit fff-health.timer failed enabled
run $((START + 40))
grep -qx 'restart fff-health.timer' "$FAKE/calls" || fail "a failed timer is not restarted: $(cat "$FAKE/calls")"
ok "a failed unit is restarted with its reason (Result=); the portal's restart does not wait for its start"

# ---------------------------------------------------------------- active without doing its job
fresh
FAKE_NFT_RC=1 run $START
grep -qx 'restart fff-guest-firewall.service' "$FAKE/calls" || fail "firewall without its table is not restarted"
field '.events[0].why' | matches -F 'nftables table inet fff_guest is not loaded' || fail "firewall: reason: $(field '.events[0].why')"
fresh
FAKE_MOUNT_RC=1 run $START
grep -qx 'restart fff-ops-scratch.service' "$FAKE/calls" || fail "scratch without its mount is not restarted"
fresh
FFF_OPS_SOCKET=$tmp/no-such.sock run $START
grep -qx 'restart fff-ops.socket' "$FAKE/calls" || fail "socket without its file is not restarted"
ok "a firewall without its table, a scratch without its mount and a socket without its file are restarted though systemd calls them active"

# ---------------------------------------------------------------- disabled
fresh
mkunit fff-ops.socket active disabled
run $START
grep -qx 'enable fff-ops.socket' "$FAKE/calls" || fail "disabled: not enabled"
[ "$(restarts fff-ops.socket)" = 0 ] || fail "disabled but active: it must be enabled, not restarted"
{ [ "$(field '.events[0].action')" = enable ] && [ "$(field '.units[] | select(.unit == "fff-ops.socket") | .enabled')" = enabled ]; } || fail "disabled: $(field -c .events) / $(field -c .units)"
fresh
mkunit fff-update.path inactive disabled
FAKE_ENABLE_RC=1 run $START
{ [ "$(field '.events[0].action')" = enable ] && [ "$(field '.events[0].ok')" = false ]; } || fail "a failed enable is not recorded: $(field -c .events)"
ok "a disabled critical unit is enabled (and a failed enable is recorded); an active one is not restarted for it"

# ---------------------------------------------------------------- left alone
fresh
mkunit fff-ops.socket inactive enabled
touch "$RUNDIR/watchdog.pause"
run $START
{ [ "$(restarts fff-ops.socket)" = 0 ] && [ "$(state_of fff-ops.socket)" = paused ]; } || fail "paused: $(cat "$FAKE/calls")"
rm "$RUNDIR/watchdog.pause"
echo "123 fff-ops.socket start waiting" >"$FAKE/jobs"
run $START
[ "$(restarts fff-ops.socket)" = 0 ] || fail "a unit with a job queued was restarted"
: >"$FAKE/jobs"
mkunit fff-ops.socket activating enabled
run $START
[ "$(restarts fff-ops.socket)" = 0 ] || fail "an activating unit was restarted"
mkunit fff-ops.socket inactive enabled
echo stopping >"$FAKE/system-state"
rm -f "$ROOT/data/unit-watchdog.json"
run $START
{ [ "$(restarts fff-ops.socket)" = 0 ] && [ ! -f "$ROOT/data/unit-watchdog.json" ]; } || fail "restarted while the VM shuts down"
echo running >"$FAKE/system-state"
echo "9 poweroff.target start waiting" >"$FAKE/jobs"
run $START
[ "$(restarts fff-ops.socket)" = 0 ] || fail "restarted with a poweroff queued"
: >"$FAKE/jobs"
mkunit fff-portal.service inactive enabled
touch "$RUNDIR/portal.hold"
run $START
{ [ "$(restarts fff-portal.service)" = 0 ] && [ "$(state_of fff-portal.service)" = held ]; } || fail "the held portal was restarted"
rm "$RUNDIR/portal.hold"
ok "paused, a queued job, a unit mid-start, a shutdown or a poweroff job, and the held portal are all left alone"

# ---------------------------------------------------------------- cannot be repaired
fresh
rm "$FAKE/fff-backup.timer"
printf 'ActiveState=inactive\nSubState=dead\nResult=success\nLoadState=masked\nUnitFileState=masked\nInactiveEnterTimestamp=\nExecMainStatus=0\n' >"$FAKE/fff-base-refresh.timer"
run $START
{ [ "$(state_of fff-backup.timer)" = gave-up ] && [ "$(state_of fff-base-refresh.timer)" = gave-up ]; } || fail "unrepairable units must show gave-up: $(field -c .units)"
{ [ "$(restarts fff-backup.timer)" = 0 ] && [ "$(restarts fff-base-refresh.timer)" = 0 ]; } || fail "restarted what cannot be repaired"
field '[.events[] | select(.unit == "fff-backup.timer")][0].why' | matches 'not installed' || fail "reason: $(field -c .events)"
ok "a missing or masked unit is reported as gave-up with its reason, never restarted"

# ---------------------------------------------------------------- history is kept and capped
fresh
for i in $(seq 1 60); do
  mkunit fff-ops.socket inactive enabled
  rm -rf "$RUNDIR/watchdog"
  run $((START + i * 10000))
done
[ "$(field '.events | length')" = 50 ] || fail "history: $(field '.events | length') events, want the last 50"
[ "$(field '.events[-1].at')" = "$(date -u -d "@$((START + 60 * 10000))" +%FT%TZ)" ] || fail "history: the newest event is not last"
ok "the file keeps the last 50 events across runs"

# ---------------------------------------------------------------- fffctl units
fresh
mkunit fff-ops.socket inactive enabled success "Thu 2026-10-08 15:33:02 UTC"
run $START
mkunit fff-ops.socket inactive enabled
out=$(FFF_NOW=$((START + 5)) bash "$G/fffctl" units 2>&1) || true
matches -E '^ +fff-ops.socket +inactive +enabled +backoff' <<<"$out" || fail "fffctl units: the socket's row: $out"
matches -F 'fff-ops.socket restart (attempt 1)' <<<"$out" || fail "fffctl units: the restart is not listed: $out"
if bash "$G/fffctl" units --check >/dev/null 2>&1; then fail "fffctl units --check passed with a stopped unit"; fi
mkunit fff-ops.socket active enabled
bash "$G/fffctl" units --check >/dev/null 2>&1 || fail "fffctl units --check failed with every unit active"
ok "fffctl units lists every unit with its state and the restarts; --check fails while one is down"
echo "all fff-watchdog scenarios pass"
