#!/usr/bin/env bash
# the fakes' bodies are single-quoted on purpose: they expand when they run
# shellcheck disable=SC2016
# fff-vm watch's checks of the path from the internet through Funnel to the portal (w681), against a fake libvirt, a fake ssh
# into a fake guest and the recorded command outputs in path-fixtures/ (see its README for where each one came from):
# one test per layer, healthy and failing, the repairs (and their limits), the alerts, the status file the portal reads and
# `fff-vm watch status`. Any machine, no root, no libvirt, no Tailscale (lint.sh runs it). Needs bash, jq, GNU coreutils,
# sed, awk, flock.
#
#   deploy/vm/test/fff-vm-path.test.sh            (from the repository root)
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
ROOT=$PWD
FIX=$ROOT/deploy/vm/test/path-fixtures
command -v jq >/dev/null || { echo "fff-vm-path.test.sh needs jq"; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0
fail() { echo "FAIL: $*"; echo "--- the last run's output:"; cat "$T/out" 2>/dev/null || true; echo "--- the state:"; cat "$T/state/watch.state" 2>/dev/null || true; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }

# ---------------------------------------------------------------- the fakes
mkdir -p "$T/bin" "$T/gbin" "$T/tmp"
# --- the host: libvirt, nft, curl (the outside probes, ntfy, the portal's health), getent
cat >"$T/bin/virsh" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
[ "${1:-}" != --connect ] || shift 2
cmd=$1
shift
echo "virsh $cmd $*" >>"$D/calls"
case "$cmd" in
  # one write: head -n 1 reading the first line must not leave the second echo to a closed pipe (SIGPIPE under pipefail)
  domstate) printf 'running\n\n' ;;
  dominfo) printf 'Name:           fff-portal\nAutostart:      enable\n' ;;
  qemu-agent-command)
    case "$*" in
      *guest-exec-status*) echo '{"return":{"exited":true,"exitcode":0}}' ;;
      *guest-exec*) rm -f "$D/ssh_down"; echo '{"return":{"pid":7}}' ;;
      *) echo '{"return":{}}' ;;
    esac ;;
  *) echo "fake virsh: $cmd is not faked" >&2; exit 1 ;;
esac
EOF
cat >"$T/bin/nft" <<'EOF'
#!/usr/bin/env bash
# the host's own table is there (fff-vm watch checks it first)
echo "table inet fff_vm { comment \"fff-vm: FF Factory portal VM (deploy/vm/host)\" }"
EOF
cat >"$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
L=$D/live
echo "host-curl $*" >>"$D/calls"
args=("$@")
url=${args[$((${#args[@]} - 1))]}
title="" prio="" data="" resolve=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -H) case "${args[$((i + 1))]}" in Title:*) title=${args[$((i + 1))]#Title: } ;; Priority:*) prio=${args[$((i + 1))]#Priority: } ;; esac ;;
    --data-binary) data=${args[$((i + 1))]} ;;
    --resolve) resolve=${args[$((i + 1))]} ;;
  esac
done
reply() { # FILE_PREFIX
  local rc
  rc=$(cat "$L/$1.rc" 2>/dev/null || echo 0)
  cat "$L/$1.out" 2>/dev/null || true
  exit "$rc"
}
case "$url" in
  https://ntfy.example.test/*) # the alert itself (a POST with data), or /v1/health
    if [ -n "$data" ] || [ -n "$title" ]; then echo "$title|$prio|$data" >>"$D/alerts"; exit 0; fi
    reply ntfy-health ;;
  https://login.tailscale.com/) exit "$(cat "$L/login.rc")" ;;
  http://10.213.41.10:8790/api/health) [ ! -e "$D/portal_down" ] || exit 7; echo '{"ok":true}' ;;
  https://fff.example-tailnet.ts.net/api/health)
    if [ -n "$resolve" ]; then
      ip=${resolve##*:443:}; ip=${ip#[}; ip=${ip%]}
      if [ -f "$L/server-$ip.rc" ]; then rc=$(cat "$L/server-$ip.rc"); else rc=$(cat "$L/server.rc"); fi
      [ "$rc" = 0 ] && cat "$L/e2e.out.ok" 2>/dev/null || true
      exit "$rc"
    fi
    reply e2e ;;
  *) echo "fake host curl: $url is not faked" >&2; exit 7 ;;
esac
EOF
cat >"$T/bin/getent" <<'EOF'
#!/usr/bin/env bash
[ "$1" = ahosts ] && cat "$FAKE_DIR/live/getent.txt"
EOF
# ssh: into the fake guest. The command runs here under PATH=$T/gbin:$PATH, as "root" (the fake sudo); stdin passes through.
cat >"$T/bin/ssh" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
while [ $# -gt 0 ]; do
  case "$1" in
    -i | -o) shift 2 ;;
    -t) shift ;;
    *@*) shift; break ;;
    *) shift ;;
  esac
done
if [ -e "$D/ssh_down" ]; then echo "ssh: connect to host 10.213.41.10 port 22: Connection refused" >&2; exit 255; fi
echo "ssh $*" >>"$D/calls"
[ $# -gt 0 ] || exit 0
cd /
PATH=$GBIN:$PATH exec bash -c "$*"
EOF
# --- the guest
cat >"$T/gbin/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" != -n ] || shift
exec "$@"
EOF
cat >"$T/gbin/tailscale" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
L=$D/live
echo "tailscale $*" >>"$D/calls"
case "$*" in
  "status --json")
    if [ -f "$L/ts-status.fail" ]; then cat "$L/ts-status.fail" >&2; exit 1; fi
    # @AGO:N@ is a time N seconds before now
    out=$(cat "$L/ts-status.json")
    for n in $(grep -o '@AGO:[0-9]*@' "$L/ts-status.json" | sort -u | tr -d '@' | cut -d: -f2); do
      out=$(printf '%s' "$out" | sed "s/@AGO:$n@/$(date -u -d "@$(($(date +%s) - n))" +%FT%TZ)/g")
    done
    printf '%s\n' "$out" ;;
  "serve status --json") cat "$L/ts-serve.json" ;;
  "funnel --bg "*)
    [ "${FAKE_REPAIR_FIXES:-0}" != 1 ] || cp "$FIX/healthy/ts-serve.json" "$L/ts-serve.json"
    echo "Available on the internet:" ;;
  cert*)
    # the key is private: it must land in a folder the caller deletes
    case "$PWD" in "$TMPDIR"/*) ;; *) echo "tailscale cert ran in $PWD, not a temp folder" >&2; exit 9 ;; esac
    [ "$(stat -c %a "$PWD")" = 700 ] || { echo "temp folder is not private" >&2; exit 9; }
    if [ -f "$L/cert.rc" ] && [ "$(cat "$L/cert.rc")" != 0 ]; then cat "$L/cert.out" >&2; exit "$(cat "$L/cert.rc")"; fi
    : >c.crt; : >c.key
    if [ "${FAKE_REPAIR_FIXES:-0}" = 1 ]; then cp "$FIX/healthy/selftest.out" "$FIX/healthy/selftest.rc" "$FIX/healthy/checkend.txt" "$L/"; fi
    echo "Wrote public cert to c.crt" ;;
  *) echo "fake tailscale: $* is not faked" >&2; exit 1 ;;
esac
EOF
cat >"$T/gbin/curl" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
L=$D/live
echo "guest-curl $*" >>"$D/calls"
case "$*" in
  *--resolve*100.64.0.5*) rc=$(cat "$L/selftest.rc"); cat "$L/selftest.out"; exit "$rc" ;;
  *) echo "fake guest curl: $* is not faked" >&2; exit 7 ;;
esac
EOF
cat >"$T/gbin/ss" <<'EOF'
#!/usr/bin/env bash
cat "$FAKE_DIR/live/ss.txt"
EOF
cat >"$T/gbin/nft" <<'EOF'
#!/usr/bin/env bash
echo "nft $*" >>"$FAKE_DIR/calls"
[ "$*" = "list chain inet fff_guest input" ] || { echo "fake nft: only 'list chain inet fff_guest input' is allowed (the watch never changes the firewall)" >&2; exit 1; }
cat "$FAKE_DIR/live/nft-input.txt"
EOF
cat >"$T/gbin/journalctl" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
echo "journalctl $*" >>"$D/calls"
case "$*" in
  "-u tailscaled --since -15min --no-pager") cat "$D/live/journal.txt" ;;
  --vacuum-size=*) [ "${FAKE_REPAIR_FIXES:-0}" != 1 ] || cp "$FIX/healthy/df.txt" "$D/live/df.txt"; echo "Vacuuming done, freed 0B of archived journals." ;;
  *) echo "fake journalctl: $* is not faked" >&2; exit 1 ;;
esac
EOF
cat >"$T/gbin/systemctl" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
L=$D/live
echo "systemctl $*" >>"$D/calls"
case "$*" in
  "is-active tailscaled") cat "$L/systemd-active.txt"; [ "$(cat "$L/systemd-active.txt")" = active ] ;;
  "restart tailscaled")
    if [ "${FAKE_REPAIR_FIXES:-0}" = 1 ]; then cp "$FIX/healthy/ts-status.json" "$FIX/healthy/systemd-active.txt" "$L/"; rm -f "$L/ts-status.fail"; fi ;;
  "restart systemd-timesyncd") [ "${FAKE_REPAIR_FIXES:-0}" != 1 ] || echo 0 >"$L/guest-clock-skew" ;;
  "show -p Environment fff-portal.service") echo "Environment=FFSB_SUPERVISOR=systemd NODE_ENV=production" ;;
  "show fff-portal.service -p NRestarts -p ActiveState -p Result") cat "$L/portal-show.txt" ;;
  *) echo "fake systemctl: $* is not faked" >&2; exit 1 ;;
esac
EOF
cat >"$T/gbin/openssl" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  s_client) echo "CERTIFICATE" ;;
  x509) cat "$FAKE_DIR/live/checkend.txt"; ! grep 'will expire' "$FAKE_DIR/live/checkend.txt" >/dev/null ;;
esac
EOF
cat >"$T/gbin/df" <<'EOF'
#!/usr/bin/env bash
cat "$FAKE_DIR/live/df.txt"
EOF
cat >"$T/gbin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "apt-get $*" >>"$FAKE_DIR/calls"
EOF
cat >"$T/gbin/date" <<'EOF'
#!/usr/bin/env bash
# the guest's clock is the real one plus the scenario's skew
if [ "$*" = "+%s" ]; then echo $(($(/bin/date +%s) + $(cat "$FAKE_DIR/live/guest-clock-skew"))); else exec /bin/date "$@"; fi
EOF
printf '#!/bin/sh\nexit 0\n' >"$T/bin/sleep"
printf '#!/bin/sh\n[ "$1" = -u ] && echo 0 || exec /usr/bin/id "$@"\n' >"$T/bin/id"
chmod +x "$T/bin"/* "$T/gbin"/*
cp "$T/bin/sleep" "$T/gbin/sleep"

# ---------------------------------------------------------------- one host
export FAKE_DIR=$T/fake FIX FFF_VM_LIB=$ROOT/deploy/vm/host FFF_VM_CONF=$T/fff-vm.conf FFF_VM_ETC=$T/etc FFF_VM_STATE=$T/state FFF_VM_RUN=$T/run GBIN=$T/gbin TMPDIR=$T/tmp
export PL_DRYRUN_MARKER=$T/guest-dry-run.json
export PATH=$T/bin:$PATH
HEALTH=$T/guest/run/fff/path-health.json
FAKE_REPAIR_FIXES=0
export FAKE_REPAIR_FIXES
echo "https://ntfy.example.test/topic-secret-3f9a" >"$T/ntfy-url"

# scen NAME...: a fresh host and VM: the healthy recordings, with each named scenario's files over them.
scen() {
  rm -rf "${T:?}/etc" "$T/state" "$T/run" "$T/guest" "$FAKE_DIR" "$PL_DRYRUN_MARKER" "$T/tmp"/*
  mkdir -p "$T/etc" "$FAKE_DIR/live" "$T/guest"
  cp "$FIX/healthy"/* "$FAKE_DIR/live/"
  cp "$FIX/healthy/e2e.out" "$FAKE_DIR/live/e2e.out.ok"
  local s
  for s in "$@"; do cp "$FIX/$s"/* "$FAKE_DIR/live/"; done
  : >"$FAKE_DIR/calls"
  : >"$FAKE_DIR/alerts"
  printf 'VM_DISK_MODE=qcow2\nVM_IMAGE_DIR=%s/images\nNTFY_URL_FILE=%s/ntfy-url\nPW_HEALTH_FILE=%s\n' "$T" "$T" "$HEALTH" >"$FFF_VM_CONF"
  FAKE_REPAIR_FIXES=0
  export FAKE_REPAIR_FIXES
  : >"$T/out"
}
# pass [N]: N runs of fff-vm watch (a minute apart in real life), the output of all in $T/out
pass() {
  local n=${1:-1} i
  for ((i = 0; i < n; i++)); do
    bash "$ROOT/deploy/vm/host/fff-vm" watch >>"$T/out" 2>&1 || fail "fff-vm watch exited $?"
  done
}
st() { grep -E "^$1=" "$T/state/watch.state" | tail -n 1 | cut -d= -f2- || true; }
verdict() { st "L$1_verdict"; }
line() { st "L$1_line"; }
is() { [ "$(verdict "$1")" = "$2" ] || fail "layer $1 is '$(verdict "$1")', want '$2' ($(line "$1"))"; }
calls() { grep -c -- "^$1" "$FAKE_DIR/calls" || true; }
said() { matches -F -- "$1" "$T/out" || fail "the journal lacks: $1"; }
never_said() { ! matches -F -- "$1" "$T/out" || fail "the journal has: $1"; }
alerts() { wc -l <"$FAKE_DIR/alerts" | tr -d ' '; }
alert_has() { matches -F -- "$1" "$FAKE_DIR/alerts" || fail "no alert with: $1 (alerts: $(tr '\n' '~' <"$FAKE_DIR/alerts"))"; }
backdate() { # KEY SECONDS: the state key's time that long ago
  sed -i "s/^$1=.*/$1=$(($(date +%s) - $2))/" "$T/state/watch.state"
}
banner() { jq -r "$1" "$HEALTH"; }
# The status file for the portal's banner, against the recording server/pathHealth.test.ts also reads (its times and the host
# name replaced so it does not change from run to run). UPDATE_FIXTURES=1 rewrites the recording.
norm() { jq -S . "$HEALTH" | sed -E 's/"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z"/"2026-10-07T18:30:00Z"/g; s/"host": "[^"]*"/"host": "ffbox"/; s/from outside \([A-Za-z0-9_.-]*, through Funnel\)/from outside (ffbox, through Funnel)/'; }
check_recording() {
  if [ "${UPDATE_FIXTURES:-0}" = 1 ]; then norm >"$FIX/$1"; fi
  norm | diff -u "$FIX/$1" - >"$T/diff" || fail "the status file differs from its recording $1 (UPDATE_FIXTURES=1 rewrites it): $(head -30 "$T/diff")"
}
no_vm_reset() { ! matches -E 'virsh (reset|destroy|shutdown)' "$FAKE_DIR/calls" || fail "the VM was reset or shut down by a path check"; }
only_reads_firewall() { ! matches -E 'nft (-f|add|insert|delete|flush)' "$FAKE_DIR/calls" || fail "the watch changed the firewall"; }

# ---------------------------------------------------------------- 1. healthy: every layer passes
scen
pass
for l in ssh 1 2 3 4 5 6 7 8 9 disk clock loop ntfy; do is "$l" ok; done
said "path L2 tailscaled: ok: BackendState=Running Online=true Health=none"
said "path L4 Serve/Funnel route: ok: fff.example-tailnet.ts.net:443 / → http://127.0.0.1:8790, AllowFunnel=true"
said "path L9 end to end: ok: https://fff.example-tailnet.ts.net/api/health answers ok:true from outside"
[ "$(banner .ok)" = true ] && [ "$(banner '.problems | length')" = 0 ] || fail "healthy: the status file shows a problem"
[ "$(banner .schema)" = 1 ] && [ "$(banner '.layers | length')" = 14 ] || fail "healthy: the status file's shape"
[ "$(alerts)" = 0 ] || fail "healthy: an alert was sent"
no_vm_reset
check_recording status-file.healthy.json
ok "healthy: every layer passes, one journal line each, the status file says ok, no alert, no repair"

# ---------------------------------------------------------------- 2. tailscaled
scen ts-health-warning
pass 3
is 2 fail
said "path L2 tailscaled: fail: BackendState=Running Online=true Health=[Tailscale could not connect to the 'sea' relay server."
[ "$(calls 'systemctl restart')" = 0 ] || fail "L2: restarted tailscaled for a health warning while the outside probe passes"
is 3 skip
is 9 ok
[ "$(banner '.problems | length')" = 0 ] && [ "$(banner '.warnings[0].id')" = 2 ] && [ "$(alerts)" = 0 ] || fail "L2: a health warning alone is a warning: no banner, no alert"
ok "tailscaled: a health warning is logged verbatim and the rest of the chain skipped, but tailscaled is not restarted for it while the portal answers from outside"
scen ts-health-warning e2e-timeout
pass
is 2 fail
is 9 fail
[ "$(calls 'systemctl restart tailscaled')" = 0 ] || fail "L2: restarted at the first failing pass"
pass
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L2: no restart at the second failing pass, with the outside probe failing"
said "path L2 repair: before: BackendState=Running"
said "path L2 repair: after: not fixed"
[ "$(alerts)" = 1 ] || fail "L2: one alert for a repair that did not fix it ($(tr '\n' '~' <"$FAKE_DIR/alerts"))"
alert_has "repair did not fix: tailscaled"
pass 3
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L2: restarted a health warning again"
no_vm_reset
ok "tailscaled: a health warning with the outside probe failing: one restart (logged before and after), one alert when it does not fix it, not repeated, the VM never reset"
scen ts-health-warning e2e-timeout
FAKE_REPAIR_FIXES=1
pass 2
is 2 ok
said "path L2 repair: after: fixed: BackendState=Running Online=true Health=none"
is 4 ok
ok "tailscaled: a restart that fixes it is recorded as fixed and the later layers run in the same pass"

scen ts-stopped
pass
is 2 fail
said "BackendState=Stopped Online=false"
[ "$(calls 'systemctl restart tailscaled')" = 0 ] || fail "L2: restarted at the first failing pass"
pass
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L2: a stopped tailscaled was not restarted at the second failing pass"
[ "$(alerts)" = 1 ] || fail "L2: one alert for a repair that did not fix it, got $(alerts)"
pass 3
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L2: restarted twice within 30 minutes"
no_vm_reset
backdate ts_restart_at 1900
pass
[ "$(calls 'systemctl restart tailscaled')" = 2 ] || fail "L2: no second restart after 30 minutes"
ok "tailscaled: a stopped one is restarted (after two failing passes), at most once in 30 minutes, the VM never reset"
scen ts-stopped
FAKE_REPAIR_FIXES=1
pass 2
is 2 ok
ok "tailscaled: a restart that brings it back is recorded as fixed"

scen ts-down
pass
is 2 fail
said "failed to connect to local tailscaled"
said "systemd says tailscaled is inactive"
scen ts-needs-login
pass 2
is 2 fail
said "BackendState=NeedsLogin"
! grep -r "login.tailscale.com/a/" "$T/state" "$T/out" "$HEALTH" >/dev/null || fail "NeedsLogin: the auth link leaked into the journal, state or status file"
ok "tailscaled: not running and NeedsLogin fail with their evidence (the login link is never logged)"

# ---------------------------------------------------------------- 3. node identity
scen identity-untagged
pass 2
is 3 fail
said "path L3 node identity: fail: tags=[none]"
is 4 skip
only_reads_firewall
[ "$(calls 'tailscale funnel --bg')" = 0 ] && [ "$(calls 'systemctl restart')" = 0 ] || fail "L3: a repair was tried for a tagging problem"
[ "$(banner '.problems | length')" = 0 ] || fail "L3: a banner while the outside probe passes"
ok "identity: an untagged node fails with its tags, is logged only (no repair); no banner while the outside path still works"
scen identity-nofunnel e2e-timeout
pass 2
is 3 fail
said "funnel+https capabilities=NO"
[ "$(banner '.problems[0].id')" = 3 ] || fail "L3: the banner's headline is layer $(banner '.problems[0].id')"
banner '.problems[0].who' | matches "tailnet admin: tag this node tag:fff-portal" || fail "L3: the banner does not name the admin's action"
ok "identity: a missing funnel capability is the banner's headline when the outside probe fails too, with who must act"

# ---------------------------------------------------------------- 4. the Serve/Funnel route
for sc in route-missing route-no-funnel route-wrong-port; do
  scen $sc
  FAKE_REPAIR_FIXES=1
  pass
  [ "$(calls 'tailscale funnel --bg http://127.0.0.1:8790')" = 1 ] || fail "$sc: the route was not set with tailscale funnel --bg http://127.0.0.1:8790"
  is 4 ok
  said "path L4 repair: before: fff.example-tailnet.ts.net:443"
  said "path L4 repair: after: fixed"
  is 5 ok
done
ok "route: a missing route, Funnel off, or a wrong target is put right with tailscale funnel --bg http://127.0.0.1:8790, logged before and after, and the next layers run"
scen route-missing
pass
is 4 fail
[ "$(calls 'tailscale funnel --bg')" = 1 ] || fail "L4: one repair at the first pass"
said "path L4 repair: after: not fixed"
pass 3
[ "$(calls 'tailscale funnel --bg')" = 1 ] || fail "L4: repaired again within 10 minutes"
[ "$(alerts)" = 1 ] || fail "L4: want one alert for a repair that did not fix it, got $(alerts)"
alert_has "tailscale funnel --bg http://127.0.0.1:8790 ran"
backdate route_repair_at 700
pass
[ "$(calls 'tailscale funnel --bg')" = 2 ] || fail "L4: no repair after 10 minutes"
ok "route: a repair that does not fix it is tried once per 10 minutes and alerts once"
scen route-missing
touch "$PL_DRYRUN_MARKER"
pass
for l in 4 5 6 7 8 9; do is "$l" skip; done
said "a migrate dry run is in place in the VM: its Funnel is off on purpose"
[ "$(calls 'tailscale funnel --bg')" = 0 ] || fail "dry run: the route was repaired"
ok "route: nothing from layer 4 on is checked or repaired while a migrate dry run is in place"
scen route-missing
printf 'PW_EXPECT_FUNNEL=0\n' >>"$FFF_VM_CONF"
pass
is 4 skip
is 9 skip
[ "$(calls 'tailscale funnel --bg')" = 0 ] || fail "PW_EXPECT_FUNNEL=0: the route was repaired"
ok "route: a tailnet-only install (PW_EXPECT_FUNNEL=0) skips layers 4 to 9"

# ---------------------------------------------------------------- 5. the certificate
scen cert-expired
FAKE_REPAIR_FIXES=1
pass
said "path L5 repair: before: https://fff.example-tailnet.ts.net/api/health from inside the VM failed (curl exit 60): curl: (60) SSL certificate problem: certificate has expired"
said "path L5 repair: after: fixed"
is 5 ok
[ "$(calls 'tailscale cert --cert-file c.crt --key-file c.key fff.example-tailnet.ts.net')" = 1 ] || fail "L5: tailscale cert was not run for the node's name"
[ -z "$(ls -A "$T/tmp")" ] || fail "L5: the certificate's temp files were not deleted: $(ls "$T/tmp")"
ok "certificate: an expired one is renewed with tailscale cert into a private temp folder, deleted afterwards"
scen cert-handshake
pass
is 5 fail
said "curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL"
[ "$(calls 'tailscale cert')" = 1 ] || fail "L5: no repair for a handshake failure"
[ -z "$(ls -A "$T/tmp")" ] || fail "L5: temp files left"
ok "certificate: a TLS handshake failure is logged verbatim and tried once"
scen cert-ratelimited
pass
is 5 fail
said "too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after 2099-10-12 12:01:03 UTC"
[ "$(st cert_retry_after)" = "$(date -u -d '2099-10-12 12:01:03' +%s)" ] || fail "L5: the ACME retry time was not kept ($(st cert_retry_after))"
backdate cert_repair_at 4000
pass
[ "$(calls 'tailscale cert')" = 1 ] || fail "L5: retried tailscale cert before the retry time ACME gave"
said "Let's Encrypt asked to wait: not retrying tailscale cert before 2099-10-12T12:01:03Z"
[ -z "$(ls -A "$T/tmp")" ] || fail "L5: temp files left"
ok "certificate: an ACME rate limit is logged verbatim and tailscale cert is not run again before the time it gave"
scen cert-expiring-soon
FAKE_REPAIR_FIXES=1
pass
is 5 warn
said "its certificate expires within 5 days"
[ "$(calls 'tailscale cert')" = 1 ] || fail "L5: an expiring certificate was not renewed"
ok "certificate: one that works but expires within 5 days is renewed ahead of time (a warning)"

# ---------------------------------------------------------------- 6. the VM's firewall
scen fw-old
pass
is 6 fail
said "ports 59917(v4) 59343(v6) that the VM's firewall (inet fff_guest input) does not accept"
is 7 skip
only_reads_firewall
[ "$(calls 'nft list chain inet fff_guest input')" -ge 1 ] || fail "L6: the chain was not read"
ok "firewall: the rules before w681 do not accept Funnel's delivery ports: the failing ports are named, nothing is changed at runtime"
scen fw-temp
pass
is 6 ok
scen
pass
is 6 ok
said "the firewall accepts every tailscaled listener on 100.64.0.5 / fd7a:115c:a1e0::5a34:ac62"
ok "firewall: the temporary per-port rule and the permanent rule for the node's Tailscale addresses both pass"
(
  # shellcheck source=../host/pathwatch.sh
  . "$ROOT/deploy/vm/host/pathwatch.sh"
  cidr_has 100.64.0.5 100.64.0.0/10 && cidr_has 100.127.255.254 100.64.0.0/10 && ! cidr_has 100.128.0.1 100.64.0.0/10 && ! cidr_has 10.0.0.1 100.64.0.0/10
  cidr_has fd7a:115c:a1e0::5a34:ac62 fd7a:115c:a1e0::/48 && ! cidr_has fd7b:115c:a1e0::1 fd7a:115c:a1e0::/48 && ! cidr_has 100.64.0.5 fd7a:115c:a1e0::/48
  cidr_has fd7a:115c:a1e0:ab12:4843:cd96:6001:1001 fd7a:115c:a1e0::/48
  cidr_has 100.64.0.5 100.64.0.5
  port_in_spec 59343 "{ 22, 59000-59999 }" && port_in_spec 443 443 && ! port_in_spec 8790 "{ 22, 443 }"
) || fail "the firewall check's address and port helpers"
ok "firewall: the address-range and port-set helpers (IPv4, IPv6, ranges)"

# ---------------------------------------------------------------- 7. the tailnet policy drops Funnel traffic
scen policy-drop
pass 2
is 7 fail
said "path L7 tailnet policy: fail: the tailnet policy drops Funnel traffic: a tailnet admin must grant tag:ingress (or *) → tag:fff-portal. 3 line(s) in 15 min, last: Oct 07 18:04:05 fff tailscaled[612]: Drop: TCP{100.100.3.13:50112 > 100.64.0.5:59917} 60 no rules matched"
is 8 skip
[ "$(calls 'systemctl restart')" = 0 ] || fail "L7: a repair was tried for a policy problem"
only_reads_firewall
[ "$(banner '.problems | length')" = 0 ] && [ "$(banner '.warnings | length')" -ge 1 ] && [ "$(alerts)" = 0 ] || fail "L7: with the outside probe passing it is a warning: no banner, no alert"
ok "policy: Funnel servers' dropped packets are matched to the tag:ingress peers by address (IPv6 and IPv4) and logged with a sample line; no repair; a warning while the outside probe passes"
scen policy-drop e2e-timeout
pass 2
[ "$(banner .ok)" = false ] || fail "L7 with a failing outside probe: no banner"
check_recording status-file.policy.json
[ "$(alerts)" = 1 ] || fail "L7: want one alert, got $(alerts): $(tr '\n' '~' <"$FAKE_DIR/alerts")"
alert_has "URGENT: Funnel is blocked by the tailnet policy|urgent|"
alert_has "a tailnet admin must grant tag:ingress (or *) → tag:fff-portal"
[ "$(banner '.problems | map(.id) | join(",")')" = "7,9" ] || fail "L7: banner layers: $(banner '.problems | map(.id) | join(",")')"
[ "$(banner '.problems[0].who')" = "tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy" ] || fail "L7: who must act: $(banner '.problems[0].who')"
banner '.problems[0].line' | matches "Drop: TCP{" || fail "L7: the log line is not in the banner's data"
[ "$(banner '.problems[0].since')" != null ] && [ "$(banner '.problems[0].name')" = "tailnet policy" ] || fail "L7: since/name"
ok "policy: with the outside probe failing too: the banner names layer 7 (since when, the log line, who must act) and one urgent alert says what to grant"
scen policy-other-drops
pass
is 7 ok
said "2 other Drop line(s)"
ok "policy: drops from sources that are not Funnel servers are not counted"

# ---------------------------------------------------------------- 8. do the Funnel servers connect at all
scen funnel-silent e2e-timeout
pass
is 8 ok
is 9 fail
pass
is 8 warn
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L8: tailscaled was not restarted once"
said "restarted tailscaled once, checking again after 5 min"
pass 2
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L8: restarted again within 5 minutes"
is 8 warn
backdate L8_restart_at 400
pass
is 8 fail
said "no Funnel server has connected for"
said "Tailscale stopped sending traffic to this node (the restart of tailscaled"
[ "$(calls 'systemctl restart tailscaled')" = 1 ] || fail "L8: restarted a second time for the same incident"
no_vm_reset
ok "funnel servers: silent while the outside probe fails: one restart of tailscaled, a second look after 5 minutes, then a failure (and no second restart)"
scen funnel-stale
pass 2
is 8 ok
[ "$(calls 'systemctl restart tailscaled')" = 0 ] || fail "L8: restarted although the outside probe passes"
ok "funnel servers: old handshakes alone are fine while the outside probe passes (nothing connects when nobody visits)"
scen funnel-nopeers
pass
is 8 fail
said "lists no Funnel server (tag:ingress) peers"
ok "funnel servers: no tag:ingress peer in tailscale status fails"

# ---------------------------------------------------------------- 9. end to end, from outside
scen e2e-timeout
pass
is 9 fail
said "from outside failed (curl exit 28): curl: (28) Operation timed out after 10002 milliseconds"
said "0 of 3 Funnel server address(es) from DNS answer, failing: 2001:db8:ffff::a 203.0.113.10 203.0.113.11"
[ "$(banner '.problems | length')" = 0 ] || fail "L9: banner at the first failing pass"
pass
[ "$(banner '.problems[0].id')" = 9 ] || fail "L9: want the banner after 2 passes"
banner '.problems[0].who' | matches "every layer inside the VM passes but the outside path fails" || fail "L9: who"
no_vm_reset
ok "end to end: a failing outside probe names every Funnel server address that fails; banner after two passes; never a VM reset"
scen e2e-one-bad-server
pass
said "2 of 3 Funnel server address(es) from DNS answer, failing: 203.0.113.11"
ok "end to end: one bad Funnel server is told from all of them"
scen host-offline
pass 3
is 9 warn
said "this host has no internet either"
[ "$(banner '.problems | length')" = 0 ] || fail "L9: a banner although the host itself has no internet"
ok "end to end: when this host has no internet either, nothing is said about Funnel (a warning)"
# ---------------------------------------------------------------- the other single points of failure
scen disk-low
FAKE_REPAIR_FIXES=1
pass
said "path Ldisk repair: after: fixed"
is disk ok
[ "$(calls 'journalctl --vacuum-size=200M')" = 1 ] && [ "$(calls 'apt-get clean')" = 1 ] || fail "disk: journal vacuum and apt-get clean"
scen disk-low
pass
is disk fail
said "1500 MB free at the fullest of / and /srv/fff, 98% used"
said "path Ldisk repair: after: not fixed"
pass 3
[ "$(calls 'journalctl --vacuum-size=200M')" = 1 ] || fail "disk: repeated within 6 hours"
[ "$(banner '.problems | map(.id) | join(",")')" = disk ] || fail "disk: the banner"
scen disk-warn
pass
is disk warn
ok "disk: a full disk is cleaned (journal vacuum, apt clean) once per 6 hours, logged before and after; low is a warning, full a banner"
scen clock-skew
FAKE_REPAIR_FIXES=1
pass
said "path Lclock repair: before: the VM's clock is"
is clock ok
[ "$(calls 'systemctl restart systemd-timesyncd')" = 1 ] || fail "clock: time sync restart"
scen clock-skew
pass 2
is clock fail
said "certificates fail past a few minutes of skew"
[ "$(calls 'systemctl restart systemd-timesyncd')" = 1 ] || fail "clock: restarted twice"
ok "clock: skew past a minute restarts the VM's time sync (never sets the clock by hand); still off is a failure"
scen
pass
is loop ok
cp "$FIX/portal-loop/portal-show.txt" "$FAKE_DIR/live/portal-show.txt"
pass 2
is loop fail
[ "$(banner '.problems | map(.id) | join(",")')" = loop ] || fail "loop: the banner"
said "fff-portal.service restarted 211 times in the last 15 min"
ok "portal restarts: a count that climbs by 5 or more within 15 minutes is a crash loop (alert and banner; systemd keeps restarting it by itself)"
scen ntfy-down
pass 4
is ntfy fail
[ "$(banner '.problems | length')" = 0 ] || fail "ntfy: a banner before 5 failing passes"
pass
is ntfy fail
said "the ntfy server ntfy.example.test does not answer /v1/health from this host"
[ "$(banner '.problems | map(.id) | join(",")')" = ntfy ] || fail "ntfy: banner"
ok "alert channel: an unreachable ntfy server is a failure after 5 passes (and only the journal and the banner carry it)"

# ---------------------------------------------------------------- ssh into the VM
scen
touch "$FAKE_DIR/ssh_down"
pass
is ssh fail
is 2 skip
[ "$(calls 'virsh .*guest-exec')" = 0 ] || fail "ssh: repaired at the first pass"
pass
[ "$(calls 'virsh qemu-agent-command')" -ge 3 ] || fail "ssh: sshd was not restarted through the guest agent"
[ "$(calls 'virsh .*guest-exec')" -ge 1 ] || fail "ssh: no guest-exec"
said "path Lssh repair: before: ssh failed (exit 255)"
is ssh ok
ok "ssh: when ssh into the VM fails twice, sshd is restarted through the guest agent (logged before and after)"
scen
pass
touch "$FAKE_DIR/ssh_down"
pass
is ssh fail
is 9 ok
said "path Lssh host-to-VM ssh: fail: ssh fffadmin@10.213.41.10 failed (exit 255)"
ok "ssh: the outside probe still runs and passes while ssh into the VM is down; fff-vm watch itself does not fail"

# ---------------------------------------------------------------- the portal itself down: fff-vm watch's own logic, the path says so
scen
touch "$FAKE_DIR/portal_down"
pass
is 1 fail
is 2 skip
is 9 skip
said "path L1 portal in the VM: fail"
no_vm_reset
ok "portal down: layer 1 fails, the layers behind it are skipped, fff-vm watch's own rules (alert, reset) are unchanged"

# ---------------------------------------------------------------- alerts: one an hour per problem, and when it clears
scen e2e-timeout
pass 5
n=$(alerts)
[ "$n" = 1 ] || fail "alerts: want one for a problem lasting 5 passes, got $n"
backdate L9_alert 3700
pass
[ "$(alerts)" = 2 ] || fail "alerts: want another after an hour"
cp "$FIX/healthy/e2e.rc" "$FAKE_DIR/live/e2e.rc"
cp "$FIX/healthy/e2e.out" "$FAKE_DIR/live/e2e.out"
pass
is 9 ok
alert_has "portal path OK again"
[ "$(alerts)" = 3 ] || fail "alerts: want a note that it passes again"
pass
[ "$(alerts)" = 3 ] || fail "alerts: the recovery note repeated"
[ "$(banner .ok)" = true ] || fail "the banner did not clear when the layer passed again"
ok "alerts: one an hour per problem, one when it passes again, and the status file clears"

# ---------------------------------------------------------------- no secrets anywhere
scen cert-ratelimited e2e-timeout
printf 'getting cert tskey-auth-kAbCdEfGh1234CNTRL-abcdefghijklmnop failed key=hunter2 https://login.tailscale.com/a/abc123def nodekey:aabbccddeeff00112233\n' >"$FAKE_DIR/live/cert.out"
pass 3
state_dump() { cat "$T/state/watch.state" "$HEALTH" "$T/out" "$FAKE_DIR/alerts"; }
state_dump | matches -F "getting cert" || fail "secrets: the test's cert output did not reach the journal"
! state_dump | matches -E 'topic-secret|tskey-|hunter2|login\.tailscale\.com/a/|nodekey:[0-9a-f]{8}' || fail "a secret reached the journal, the state, the status file or an alert"
ok "secrets: auth keys, login links, node keys and key=values never reach a journal line, the state, the status file or an alert; the ntfy topic is never printed"

# ---------------------------------------------------------------- maintenance and the switch
scen
mkdir -p "$T/run"
touch "$T/run/maintenance"
pass
[ "$(calls 'tailscale')" = 0 ] && [ "$(calls 'ssh')" = 0 ] || fail "maintenance: a path check ran"
ok "maintenance: no path check runs during it"
scen
printf 'PW_CHECKS=off\n' >>"$FFF_VM_CONF"
pass
[ "$(calls 'tailscale')" = 0 ] || fail "PW_CHECKS=off: a path check ran"
ok "PW_CHECKS=off: no path checks"

# ---------------------------------------------------------------- fff-vm watch status
scen policy-drop e2e-timeout
pass 2
bash "$ROOT/deploy/vm/host/fff-vm" watch status >"$T/status" 2>&1 || fail "fff-vm watch status exited $?"
for w in "Portal path" "tailnet policy" "Funnel servers" "end to end" "VM disk" "alert channel" "who: tailnet admin: grant tag:ingress"; do
  matches -F "$w" "$T/status" || fail "fff-vm watch status lacks: $w ($(cat "$T/status"))"
done
matches -E '^  7 +tailnet policy +fail ' "$T/status" || fail "status: layer 7's row"
bash "$ROOT/deploy/vm/host/fff-vm" watch bogus >"$T/out" 2>&1 && fail "watch bogus succeeded" || true
ok "fff-vm watch status: the last result of every layer, since when, who must act"

echo "fff-vm-path.test.sh: $PASS passed"
