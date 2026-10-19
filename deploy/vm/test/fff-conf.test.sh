#!/usr/bin/env bash
# the fake logger and the refused values are single-quoted on purpose
# shellcheck disable=SC2016
# `fffctl conf` (w1537): fff.conf's settings, read and changed, against a fixture fff.conf that holds secrets; no root and no
# VM: run by lint.sh. What it checks (lothsahn: "It should be able to touch any settings that aren't credentials or keys or
# secrets", and "Make sure when it prints, it doesn't print any secrets. Just prints the settings that changed."):
#   set prints exactly one line, the changed setting (old -> new, when it takes effect), keeps fff.conf.prev, changes that
#   one line, and lib.sh's load_conf (which fff-health runs every 30 s) then reads the new value;
#   an unchanged value prints "no change" and writes nothing;
#   a refused key (a secret by name, CONF_REFUSED, not a setting) and a bad value change nothing and echo no value;
#   no output and no log line carries a secret from the fixture, and a token under an allowed name shows as <redacted>;
#   every key fff.conf.example defines is classified (settable or refused with a reason).
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\n[ "$1" = -- ] && shift\necho "$*" >>"%s/logger"\n' "$tmp" >"$tmp/bin/logger"
chmod +x "$tmp/bin/logger"
: >"$tmp/logger"

oat="sk-ant-oat01-$(printf 'A%.0s' {1..60})"
ghp="ghp_$(printf 'b%.0s' {1..36})"
secrets=("$oat" "$ghp" zz-secret-host zz-secret-keyfile zz-vault-keyfile zz-secret-value hunter2hunter2)
conf=$tmp/fff.conf
cat >"$conf" <<EOF
# a fixture: secrets beside settings
HEALTH_START_GRACE_SEC=120
BACKUP_SSH_TARGET=fff-backup@zz-secret-host
BACKUP_SSH_KEY=/etc/fff/zz-secret-keyfile
FFF_VAULT_KEY=/etc/fff/zz-vault-keyfile
MY_API_TOKEN=$oat
DB_PASSWORD=hunter2hunter2
BASE_BRANCH=$ghp
export WATCHDOG_BACKOFF_SEC=30
EOF
cp "$conf" "$tmp/fixture"

all=$tmp/all # every output, checked for secrets at the end
ctl() { FFF_TEST_NOROOT=1 FFF_LIB=$G FFF_CONF=$conf FFF_PATH_PREFIX=$tmp/bin bash $G/fffctl conf "$@" 2>&1 | tee -a "$all"; }
ok() { echo "ok: $*"; }

# ---- get: every setting, the refused ones redacted, every key classified
out=$(ctl get)
keys=$(grep -cE '^[A-Z][A-Z0-9_]*=' $G/fff.conf.example)
[ "$(printf '%s\n' "$out" | wc -l)" -eq "$keys" ] || fail "get: not one line per fff.conf.example key ($keys): $out"
printf '%s\n' "$out" | matches -xF "HEALTH_START_GRACE_SEC=120 (set in $conf)" || fail "get: the grace from fff.conf: $out"
printf '%s\n' "$out" | matches -xF "HEALTH_FAILS_BEFORE_RESTART=4 (default)" || fail "get: a default: $out"
printf '%s\n' "$out" | matches -xF "WATCHDOG_BACKOFF_SEC=30 (set in $conf)" || fail "get: an export line: $out"
printf '%s\n' "$out" | matches -E "^BACKUP_SSH_TARGET=<redacted> \(a person's: " || fail "get: the backup target is not redacted: $out"
printf '%s\n' "$out" | matches -E "^BACKUP_SSH_KEY=<redacted> \(a person's: its name says" || fail "get: the backup key is not redacted by its name: $out"
printf '%s\n' "$out" | matches -xF "BASE_BRANCH=<redacted> (set in $conf)" || fail "get: a token under an allowed name is not redacted: $out"
if printf '%s\n' "$out" | matches -F 'not a setting fff.conf.example lists'; then
  fail "get: a key of fff.conf.example is neither in CONF_CHECK nor in CONF_REFUSED (fffctl): classify it: $(printf '%s\n' "$out" | grep -F 'not a setting')"
fi
if printf '%s\n' "$out" | matches -E '^(MY_API_TOKEN|DB_PASSWORD|FFF_VAULT_KEY)'; then fail "get: printed a line fff.conf.example does not define: $out"; fi
[ "$(ctl get HEALTH_START_GRACE_SEC)" = "HEALTH_START_GRACE_SEC=120 (set in $conf)" ] || fail "get KEY: $(ctl get HEALTH_START_GRACE_SEC)"
[ "$(ctl get BACKUP_SSH_TARGET)" = "BACKUP_SSH_TARGET=<redacted> (a person's: where the backups go: the account the backup key logs in to)" ] || fail "get KEY: a refused one: $(ctl get BACKUP_SSH_TARGET)"
if ctl get MY_API_TOKEN >/dev/null; then fail "get: a key fff.conf.example does not define was answered"; fi
ok "conf get prints every setting, one line each, the refused ones and tokens as <redacted>, and every key is classified"

# ---- set: one line out, one line changed, the file before kept, and load_conf reads it
out=$(ctl set HEALTH_START_GRACE_SEC 300)
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] || fail "set: printed more than the changed setting: $out"
[ "$out" = "HEALTH_START_GRACE_SEC: 120 -> 300 (takes effect at the next health check, within 30 s (fff-health reads fff.conf on every run); nothing restarts; the file before is $conf.prev)" ] || fail "set: $out"
cmp -s "$conf.prev" "$tmp/fixture" || fail "set: fff.conf.prev is not the file before"
[ "$(diff "$tmp/fixture" "$conf" | grep -c '^[<>]')" -eq 2 ] || fail "set: changed more than the one line: $(diff "$tmp/fixture" "$conf")"
matches -x 'HEALTH_START_GRACE_SEC=300' "$conf" || fail "set: no HEALTH_START_GRACE_SEC=300 line"
got=$(FFF_CONF=$conf FFF_LIB=$G bash -c '. "$FFF_LIB/lib.sh"; load_conf; echo "$HEALTH_START_GRACE_SEC"')
[ "$got" = 300 ] || fail "set: load_conf (fff-health's, every run) reads $got, not 300"
matches -xF 'conf set HEALTH_START_GRACE_SEC: 120 -> 300' "$tmp/logger" || fail "set: not logged: $(cat "$tmp/logger")"
ok "conf set prints only the changed setting, keeps fff.conf.prev, changes one line, and fff-health's load_conf reads it"

cp "$conf" "$tmp/before"
[ "$(ctl set HEALTH_START_GRACE_SEC 300)" = "HEALTH_START_GRACE_SEC: no change (300)" ] || fail "set: the same value: $(ctl set HEALTH_START_GRACE_SEC 300)"
[ "$(ctl set HEALTH_FAILS_BEFORE_RESTART 4)" = "HEALTH_FAILS_BEFORE_RESTART: no change (4, the default)" ] || fail "set: the default: $(ctl set HEALTH_FAILS_BEFORE_RESTART 4)"
cmp -s "$conf" "$tmp/before" || fail "set: an unchanged value wrote the file"
ok "conf set of an unchanged value prints \"no change\" and writes nothing"

out=$(ctl set HEALTH_FAILS_MAX 16)
case $out in "HEALTH_FAILS_MAX: 32 -> 16 (takes effect at the next health check"*) ;; *) fail "set: an appended setting: $out" ;; esac
[ "$(tail -n 1 "$conf")" = HEALTH_FAILS_MAX=16 ] || fail "set: a setting with no line was not appended"
out=$(ctl set WATCHDOG_BACKOFF_SEC 60)
case $out in "WATCHDOG_BACKOFF_SEC: 30 -> 60 "*) ;; *) fail "set: an export line: $out" ;; esac
{ [ "$(grep -c WATCHDOG_BACKOFF_SEC "$conf")" -eq 1 ] && matches -x WATCHDOG_BACKOFF_SEC=60 "$conf"; } || fail "set: the export line was not replaced"
out=$(ctl set BASE_BRANCH main)
case $out in "BASE_BRANCH: <redacted> -> main (takes effect at the next base clone refresh"*) ;; *) fail "set: the old token was not redacted: $out" ;; esac
out=$(ctl set BACKUP_TIME 10:45)
printf '%s' "$out" | matches -F 'only at the next fffctl update' || fail "set: BACKUP_TIME does not say it needs an update: $out"
out=$(ctl set UPDATE_VERIFY_SEC '')
case $out in "UPDATE_VERIFY_SEC: no change ((empty), the default)") ;; *) fail "set: an empty value: $out" ;; esac
ok "conf set appends a missing setting, replaces an export line, redacts an old token and says when a setting needs an update"

# ---- refused keys and bad values: nothing changes, no value is echoed
cp "$conf" "$tmp/before"
for k in BACKUP_SSH_TARGET BACKUP_SSH_KEY BACKUP_RECIPIENTS_FILE FFF_VAULT_KEY MY_API_TOKEN DB_PASSWORD FFF_REPO_URL FFF_BRANCH BASE_REPO_URL \
  FFF_ROOT OPS_ALLOW_NETS OPS_MEMORY_MAX NOT_A_SETTING lower; do
  rc=0
  out=$(ctl set "$k" zz-secret-value) || rc=$?
  [ "$rc" -ne 0 ] || fail "set $k was not refused: $out"
  printf '%s' "$out" | matches -E 'refused: .+\. A person changes it' || fail "set $k: no reason: $out"
done
for v in 5 99999 abc '300;id' '$(id)' '' ' 300' 300.5 "$oat"; do
  rc=0
  out=$(ctl set HEALTH_START_GRACE_SEC "$v") || rc=$?
  [ "$rc" -ne 0 ] || fail "set HEALTH_START_GRACE_SEC '$v' was not refused: $out"
  printf '%s' "$out" | matches -F 'a whole number from 10 to 3600 (nothing changed)' || fail "set '$v': $out"
  if [[ $v =~ [^0-9] ]] && printf '%s' "$out" | matches -F -- "$v"; then fail "set: a refused value was echoed: $out"; fi
done
for kv in 'BACKUP_INCLUDE_REVIEW maybe' 'BACKUP_TIME 25:00' 'BASE_BRANCH ../x' 'BACKUP_REMOTE_DIR /etc' 'NODE_MAJOR 7'; do
  rc=0
  # shellcheck disable=SC2086 # key and value
  out=$(ctl set $kv) || rc=$?
  [ "$rc" -ne 0 ] || fail "set $kv was not refused: $out"
done
cmp -s "$conf" "$tmp/before" || fail "a refused key or value changed fff.conf"
ok "conf set refuses the credentials, keys, secrets, the deploy's code, the layout, the worker's fences, unknown keys and bad values, and changes nothing"

# ---- no secret anywhere
for s in "${secrets[@]}"; do
  if matches -F -- "$s" "$all"; then fail "an output carries a secret ($s): $(grep -F -- "$s" "$all" | head -n 3)"; fi
  if matches -F -- "$s" "$tmp/logger"; then fail "a log line carries a secret ($s)"; fi
done
ok "no output and no log line carries a secret from the fixture"
