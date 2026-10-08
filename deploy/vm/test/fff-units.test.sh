#!/usr/bin/env bash
# The portal VM's systemd units as a whole (w698), no root and no VM: run by lint.sh. What it checks:
#   - every critical unit (FFF_CRITICAL_UNITS, guest/lib.sh) has an [Install] section with the right WantedBy target, and
#     install.sh enables the whole list (so none is left disabled after an install or a fffctl update);
#   - a service that runs all the time restarts by itself (Restart=always or on-failure) with a StartLimit that is neither
#     the default nor missing; a oneshot that must stay active (RemainAfterExit) restarts on failure, rate-limited;
#   - no socket, path or timer orders itself After= or Requires= a service: with sockets.target before basic.target and
#     every service after basic.target, that is an ordering cycle, and systemd breaks it at boot by dropping the socket's
#     job (fff-ops.socket, 2026-10-08). Checked by rule, and by systemd-analyze on the whole boot graph when it is there,
#     where the old socket must fail the same check (the test proves it sees the bug);
#   - every other unit file is triggered by a timer, a path or a socket, or is a critical unit; templates (*.in) render
#     with fff.conf.example's values and no @TOKEN@ is left.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
U=$G/units
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ---------------------------------------------------------------- the units as install.sh writes them
export FFF_CONF=/nonexistent
# shellcheck disable=SC1091
. "$G/lib.sh"
load_conf
# FFF_UNITS_OUT=DIR: render into DIR and keep it (lint.sh --units verifies them with systemd-analyze).
out=${FFF_UNITS_OUT:-$tmp/units}
mkdir -p "$out"
for f in "$U"/*; do
  name=$(basename "$f")
  case $name in
    *.in) ;;
    *.conf) ;;
    *) cp "$f" "$out/$name" ;;
  esac
done
# shellcheck disable=SC2034 # the next three are render_unit's (${!name})
RESOLVERS="127.0.0.53"
# shellcheck disable=SC2034
OPS_IMAGE_DIR=$(dirname "$OPS_IMAGE")
# shellcheck disable=SC2034
OPS_ROOT_PARENT=$(dirname "$OPS_ROOT")
for f in "$U"/*.in; do
  name=$(basename "$f" .in)
  render_unit "$f" OPS_DISK_MB OPS_ROOT OPS_IMAGE OPS_USER OPS_IMAGE_DIR OPS_ROOT_PARENT FFF_LIB FFF_ROOT OPS_ALLOW_NETS RESOLVERS OPS_MEMORY_MAX OPS_RUNTIME_MAX BACKUP_TIME >"$out/$name"
done
! grep -E '@[A-Z_]+@' "$out"/* >/dev/null || fail "a template left a token: $(grep -HE '@[A-Z_]+@' "$out"/*)"
mkdir -p "$out/tailscaled.service.d"
cp "$U/tailscaled-restart.conf" "$out/tailscaled.service.d/10-fff-restart.conf"
ok "$(find "$U" -name '*.in' | wc -l) templates render with fff.conf.example's values; no token is left"

# value UNITFILE SECTION KEY: the last value of KEY in SECTION ("" when none).
value() { awk -v sec="[$2]" -v key="$3" '/^\[/ {cur = $0} cur == sec && index($0, key "=") == 1 {v = substr($0, length(key) + 2)} END {print v}' "$1"; }
has_section() { grep -qx "\[$2\]" "$1"; }

# ---------------------------------------------------------------- install: WantedBy and enable
for u in "${FFF_CRITICAL_UNITS[@]}"; do
  case $u in
    tailscaled.service) continue ;; # Tailscale's package ships it, enabled by its postinst; install.sh enables it as well
  esac
  f=$out/$u
  [ -f "$f" ] || fail "$u is a critical unit but $U has no file for it"
  has_section "$f" Install || fail "$u has no [Install] section: it would not start at boot"
  want=$(value "$f" Install WantedBy)
  case $u in
    *.service) ok_targets="multi-user.target" ;;
    *.socket) ok_targets="sockets.target" ;;
    *.timer) ok_targets="timers.target" ;;
    *.path) ok_targets="multi-user.target paths.target" ;;
    *) fail "$u: a kind this test does not know" ;;
  esac
  [[ " $ok_targets " == *" $want "* ]] || fail "$u: WantedBy=$want, want one of: $ok_targets"
done
# shellcheck disable=SC2016 # fixed strings from install.sh, not expanded here
grep -qF 'systemctl enable "${FFF_CRITICAL_UNITS[@]}"' $G/install.sh || fail "install.sh does not enable the whole FFF_CRITICAL_UNITS list"
# shellcheck disable=SC2016
grep -qF 'enable_state_ok "$(systemctl is-enabled "$u"' $G/install.sh || fail "install.sh does not check that each critical unit is enabled afterwards"
ok "${#FFF_CRITICAL_UNITS[@]} critical units: each has an [Install] with the right WantedBy; install.sh enables all of them and checks"

# ---------------------------------------------------------------- Restart= and StartLimit
for u in "${FFF_CRITICAL_UNITS[@]}"; do
  case $u in *.service) ;; *) continue ;; esac
  f=$out/$u
  [ "$u" != tailscaled.service ] || f=$out/tailscaled.service.d/10-fff-restart.conf
  type=$(value "$f" Service Type)
  restart=$(value "$f" Service Restart)
  case $restart in
    always | on-failure) ;;
    *) fail "$u: Restart=$restart (want always or on-failure): a crash would leave it down" ;;
  esac
  if [ "$type" = oneshot ] && [ "$restart" = always ]; then fail "$u: a oneshot cannot have Restart=always (systemd refuses the unit)"; fi
  interval=$(value "$f" Unit StartLimitIntervalSec)
  [ -n "$interval" ] || fail "$u: no StartLimitIntervalSec: the default (10 s, 5 starts) gives up on a unit that crashes more slowly"
  if [ "$interval" != 0 ]; then
    burst=$(value "$f" Unit StartLimitBurst)
    [ -n "$burst" ] || fail "$u: StartLimitIntervalSec=$interval without a StartLimitBurst"
  fi
  [ -n "$(value "$f" Service RestartSec)" ] || [ "$u" = fff-portal.service ] || fail "$u: no RestartSec"
done
ok "every critical service restarts (Restart=always or on-failure) with a StartLimit of its own"

# ---------------------------------------------------------------- no socket, path or timer after a service
rule_violations() { # DIR: unit files of kinds that sit before basic.target, naming a service in After=/Requires=/BindsTo=/Wants=/Before=
  local f key
  for f in "$1"/*.socket "$1"/*.path "$1"/*.timer; do
    [ -f "$f" ] || continue
    for key in After Requires BindsTo Wants; do
      value "$f" Unit "$key" | tr ' ' '\n' | grep -E '\.service$' | sed "s|^|$(basename "$f") $key=|" || true
    done
  done
}
bad=$(rule_violations "$out")
[ -z "$bad" ] || fail "a socket, path or timer is ordered after (or requires) a service, which closes an ordering cycle at boot (basic.target > sockets.target > it > the service > basic.target):
$bad"
ok "no socket, path or timer is ordered after or requires a service"

# The boot graph, with systemd's own check: units installed as enable would (symlinks in WantedBy's .wants), the whole of
# default.target verified. The old fff-ops.socket (After/Requires fff-ops-scratch.service) must fail it: that is the bug.
graph_check() { # DIR: prints systemd-analyze's ordering-cycle lines for default.target
  local dir=$1 f want
  for f in "$dir"/*.service "$dir"/*.socket "$dir"/*.timer "$dir"/*.path; do
    [ -f "$f" ] || continue
    want=$(value "$f" Install WantedBy)
    for w in $want; do mkdir -p "$dir/$w.wants" && ln -sf "$f" "$dir/$w.wants/$(basename "$f")"; done
  done
  chmod -R a+rX "$dir"
  find "$dir" -type f -exec chmod 0644 {} +
  SYSTEMD_UNIT_PATH="$dir:" systemd-analyze verify --man=no default.target 2>&1 | grep -i 'ordering cycle' || true
}
if command -v systemd-analyze >/dev/null; then
  cyc=$(graph_check "$out")
  [ -z "$cyc" ] || fail "the boot graph has an ordering cycle:
$cyc"
  old=$tmp/old
  mkdir -p "$old"
  cp "$out"/*.service "$out"/*.timer "$out"/*.path "$out"/fff-ops.socket "$old/"
  # the socket as it was until w698: ordered after, and requiring, the scratch service
  awk '{print} /^Description=/ {print "After=fff-ops-scratch.service"; print "Requires=fff-ops-scratch.service"}' "$old/fff-ops.socket" >"$old/fff-ops.socket.new"
  mv "$old/fff-ops.socket.new" "$old/fff-ops.socket"
  cyc=$(graph_check "$old")
  [ -n "$cyc" ] || fail "systemd-analyze does not see the ordering cycle of the old fff-ops.socket: this test would not have caught the bug"
  ok "the boot graph has no ordering cycle (systemd-analyze verify default.target); the old fff-ops.socket, ordered after the scratch service, is caught by the same check"
else
  echo "skipped: systemd-analyze is not here; the boot-graph check runs in CI"
fi

# ---------------------------------------------------------------- nothing is left to chance
for f in "$out"/*.service; do
  name=$(basename "$f")
  crit=0
  for u in "${FFF_CRITICAL_UNITS[@]}"; do [ "$u" != "$name" ] || crit=1; done
  [ "$crit" = 0 ] || continue
  base=${name%.service}
  base=${base%@}
  if [ -f "$out/$base.timer" ] || [ -f "$out/$base.path" ] || [ -f "$out/$base.socket" ]; then continue; fi
  fail "$name is neither a critical unit nor triggered by a timer, path or socket: nothing starts it"
done
ok "every other service is triggered by a timer, a path or a socket"
echo "all unit checks pass"
