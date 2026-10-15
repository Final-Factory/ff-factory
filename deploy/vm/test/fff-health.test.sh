#!/usr/bin/env bash
# the fakes written below are single-quoted on purpose: they read their variables when they run
# shellcheck disable=SC2016
# The portal VM's health restart (deploy/vm/guest/fff-health), against a fake systemctl and curl: no root, no VM, run by
# lint.sh. What it checks (w1377: on 2026-10-15 a portal too busy to answer was restarted every 4 minutes for 72 minutes):
#   an answering portal is left alone; one that stops answering is restarted after HEALTH_FAILS_BEFORE_RESTART checks in a
#   row, with a line of what its processes were doing first; a second restart within the back-off window waits for twice the
#   checks, a third for four times, capped at HEALTH_FAILS_MAX; one answer in between starts the count again; past the window
#   it is back to the first count; nothing is checked inside the start grace or while the portal is held.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=$PWD/deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export FAKE=$tmp/fake
mkdir -p "$FAKE" "$tmp/bin" "$tmp/lib" "$tmp/run" "$tmp/cg/fake.slice"
cp "$G/lib.sh" "$G/fff.conf.example" "$G/fff-health" "$tmp/lib/"
printf '#!/bin/sh\nexit 0\n' >"$tmp/lib/fff-watchdog"
printf '#!/bin/sh\nexit 0\n' >"$tmp/lib/fff-update"
cat >"$tmp/bin/systemctl" <<'EOF'
#!/bin/bash
echo "$*" >>"$FAKE/calls"
case "$1 $2" in
  "is-active --quiet") exit "${FAKE_ACTIVE_RC:-0}" ;;
  "show -p")
    case $3 in
      ExecMainStartTimestampMonotonic) echo "${FAKE_STARTED_US:-0}" ;;
      ControlGroup) echo /fake.slice ;;
      *) echo ;;
    esac ;;
  restart*) echo "$2" >>"$FAKE/restarted" ;;
  *) echo "fake systemctl: $*" >&2; exit 1 ;;
esac
EOF
printf '#!/bin/sh\nexit "${FAKE_CURL_RC:-0}"\n' >"$tmp/bin/curl"
chmod +x "$tmp/bin/systemctl" "$tmp/bin/curl" "$tmp/lib/fff-watchdog" "$tmp/lib/fff-update"
echo $$ >"$tmp/cg/fake.slice/cgroup.procs"
echo 734003200 >"$tmp/cg/fake.slice/memory.current"
: >"$tmp/fff.conf"

export FFF_SYSTEMCTL=$tmp/bin/systemctl FFF_PATH_PREFIX=$tmp/bin FFF_LIB=$tmp/lib FFF_CONF=$tmp/fff.conf FFF_TEST_NOROOT=1
export FFF_RUN_DIR=$tmp/run FFF_CGROUP_ROOT=$tmp/cg FFF_UPTIME=100000
START=1760522229 # 2026-10-15T09:57:09Z

check() { # NOW: one run of fff-health at that time; its log lines go to $tmp/log
  FFF_NOW=$1 bash "$tmp/lib/fff-health" 2>>"$tmp/log" || { cat "$tmp/log"; fail "fff-health exited $?"; }
}
restarted() { if [ -f "$FAKE/restarted" ]; then wc -l <"$FAKE/restarted"; else echo 0; fi; }
fresh() { rm -rf "${tmp:?}/run" "$FAKE/restarted" "$FAKE/calls"; mkdir -p "$tmp/run"; : >"$tmp/log"; }
# fail_until N T: checks every 30 s from T while the portal does not answer, until the N-th restart; prints the time after.
fail_until() {
  local want=$1 t=$2 n=0
  while [ "$(restarted)" -lt "$want" ]; do
    check "$t"
    t=$((t + 30)) n=$((n + 1))
    [ "$n" -le 200 ] || fail "no restart $want after 200 checks"
  done
  echo "$t"
}
checks_to() { # N T: how many failed checks the N-th restart took, from T
  local before t
  before=$(grep -c 'did not answer' "$tmp/log" 2>/dev/null || true)
  t=$(fail_until "$1" "$2")
  echo $(($(grep -c 'did not answer' "$tmp/log") - before)) "$t"
}

# ---------------------------------------------------------------- answering
fresh
FAKE_CURL_RC=0 check $START
[ "$(restarted)" = 0 ] && [ ! -s "$tmp/log" ] || fail "answering: $(cat "$tmp/log")"
ok "an answering portal: nothing logged, nothing restarted"

# ---------------------------------------------------------------- the first restart: 4 checks, with the diagnostics first
fresh
export FAKE_CURL_RC=7
read -r n t < <(checks_to 1 $START)
[ "$n" = 4 ] || fail "first restart after $n checks, not 4: $(cat "$tmp/log")"
grep -q 'did not answer (4 of 4)' "$tmp/log" || fail "the count: $(cat "$tmp/log")"
grep -q "before the restart: load .*available, the portal's cgroup 700 MB; its processes, busiest first: " "$tmp/log" || fail "no diagnostics line: $(cat "$tmp/log")"
grep -q 'restart 1 within 60 min; another one in that time waits for 8 checks' "$tmp/log" || fail "the restart line: $(cat "$tmp/log")"
ok "the first restart after 4 failed checks, its diagnostics logged before it"

# ---------------------------------------------------------------- the back-off: 8, 16, 32, 32
read -r n t < <(checks_to 2 "$t")
[ "$n" = 8 ] || fail "second restart after $n checks, not 8"
read -r n t < <(checks_to 3 "$t")
[ "$n" = 16 ] || fail "third restart after $n checks, not 16"
read -r n t < <(checks_to 4 "$t")
[ "$n" = 32 ] || fail "fourth restart after $n checks, not 32"
read -r n t < <(checks_to 5 "$t")
[ "$n" = 32 ] || fail "fifth restart after $n checks, not 32 (the cap)"
ok "restarts within the hour back off: 4, 8, 16, 32 checks, capped at 32"

# ---------------------------------------------------------------- an answer starts the count again
for i in 1 2 3; do check $((t + i * 30)); done
FAKE_CURL_RC=0 check $((t + 120))
grep -q 'did not answer (3 of 32)' "$tmp/log" || fail "the count before the answer: $(tail -n 3 "$tmp/log")"
[ ! -e "$tmp/run/health.fails" ] || fail "an answer left the count"
ok "one answer in between starts the count again"

# ---------------------------------------------------------------- past the window: 4 again
read -r n _ < <(checks_to 6 $((t + 3700)))
[ "$n" = 4 ] || fail "a restart an hour after the last took $n checks, not 4"
ok "an hour after the last restart, 4 checks again"

# ---------------------------------------------------------------- the grace and the hold
fresh
FAKE_STARTED_US=$(((100000 - 60) * 1000000)) check $START
[ ! -s "$tmp/log" ] && ! grep -q '^restart' "$FAKE/calls" || fail "inside the grace: $(cat "$tmp/log")"
touch "$tmp/run/portal.hold"
for i in 1 2 3 4 5; do check $((START + i * 30)); done
[ "$(restarted)" = 0 ] && [ ! -s "$tmp/log" ] || fail "while held: $(cat "$tmp/log")"
ok "nothing checked inside the start grace or while the portal is held"
