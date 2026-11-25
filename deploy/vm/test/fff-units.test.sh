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
  render_unit "$f" OPS_DISK_MB OPS_ROOT OPS_IMAGE OPS_USER OPS_IMAGE_DIR OPS_ROOT_PARENT FFF_LIB FFF_ROOT OPS_ALLOW_NETS RESOLVERS OPS_MEMORY_MAX OPS_RUNTIME_MAX BACKUP_TIME AGENT_USER AGENT_ROOT "BASE_PATH=${BASE_PATH:-$FFF_ROOT/base}" >"$out/$name"
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

# ---------------------------------------------------------------- the portal's journal group (w920)
# portal_logs reads the journal as the server's account: the systemd-journal group, for that service only, in a drop-in
# install.sh writes only where the group exists (a unit naming a missing group does not start).
dropin=$U/fff-portal-journal.conf
[ "$(value "$dropin" Service SupplementaryGroups)" = systemd-journal ] || fail "$dropin does not give fff-portal.service SupplementaryGroups=systemd-journal"
! grep -qE '^(Group|User|AmbientCapabilities|CapabilityBoundingSet|NoNewPrivileges)=' "$dropin" || fail "$dropin changes more than the supplementary group"
grep -qF 'getent group systemd-journal' $G/install.sh || fail "install.sh does not check that the systemd-journal group exists before using it"
# shellcheck disable=SC2016
grep -qF 'fff-portal.service.d/20-journal.conf 0644 <"$here/units/fff-portal-journal.conf"' $G/install.sh || fail "install.sh does not write the journal drop-in"
ok "fff-portal.service gets the systemd-journal group through a drop-in that install.sh writes only where the group exists"

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
  local verify
  verify=$(SYSTEMD_UNIT_PATH="$dir:" systemd-analyze verify --man=no default.target 2>&1 || true)
  # Only a cycle through one of ours: a throwaway runner's own units are not this test's business.
  if grep -qi 'ordering cycle' <<<"$verify" && grep -q 'fff-' <<<"$verify"; then grep -iE 'ordering cycle|dependency on|deleted' <<<"$verify"; fi
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
  # Not critical on purpose, started at boot all the same: install.sh enables it (fff-agent-views.service, w5598).
  if [ "$(value "$f" Install WantedBy)" = multi-user.target ] && grep -qE "systemctl enable .*\b$name\b" $G/install.sh; then continue; fi
  fail "$name is neither a critical unit nor triggered by a timer, path or socket: nothing starts it"
done
ok "every other service is triggered by a timer, a path or a socket"

# ---------------------------------------------------------------- credentials (w4500)
# SetCredential=ID: with an empty value is not valid systemd syntax: systemd logs "Invalid syntax, ignoring" on every
# daemon-reload and drops the line (fff-portal.service:40, 2026-11-16). lint.sh --units also fails on any such warning
# from systemd-analyze; this rule needs no systemd.
bad=$(grep -HnE '^[[:space:]]*SetCredential(Encrypted)?=[^:]*:[[:space:]]*$' "$out"/* "$U"/*.conf 2>/dev/null || true)
[ -z "$bad" ] || fail "an empty SetCredential= value, which systemd ignores as invalid syntax: $bad"
ok "no unit sets a credential to an empty value"

# ---------------------------------------------------------------- the vault key and the portal's memory (w5506)
# No process of the fff account (an orchestrator's tools, git, gh) reads the vault key: systemd opens the key file and
# hands the server a descriptor (OpenFile=), not a credential file fff may read (LoadCredential=); the server runs an
# execute-only copy of node, so its /proc/<pid>/environ, mem and fd are root's; SIGUSR1 opens no inspector.
p=$out/fff-portal.service
[ "$(value "$p" Service OpenFile)" = /etc/fff/vault.key:fff-vault-key:read-only ] || fail "fff-portal.service does not open the vault key for the server (OpenFile=/etc/fff/vault.key:fff-vault-key:read-only)"
! grep -qE '^LoadCredential(Encrypted)?=' "$p" || fail "fff-portal.service still hands the vault key over as a credential file the fff account may read"
[ "$(value "$p" Service ExecStart)" = '/usr/local/lib/fff/node-portal --disable-sigusr1 server/index.ts' ] || fail "fff-portal.service does not run the execute-only node with --disable-sigusr1: $(value "$p" Service ExecStart)"
grep -qF "install -o root -g root -m 0111 /usr/bin/node /usr/local/lib/fff/node-portal.new" "$p" || fail "fff-portal.service does not make the execute-only node (root's, 0111) before it starts"
grep -q "VAULT_CREDENTIAL = 'fff-vault-key'" server/vault.ts || fail "server/vault.ts no longer names the descriptor fff-vault-key, which OpenFile= gives it"
ok "fff-portal.service opens the vault key as a descriptor and runs an execute-only node without SIGUSR1's inspector"
# A rollback puts the older release's portal unit back: code from before w5506 reads its key from LoadCredential=.
grep -q '^portal_unit_back()' deploy/vm/guest/fff-update || fail "fff-update has no portal_unit_back (w5506)"
# shellcheck disable=SC2016 # the literal $prev of fff-update's source
sed -n '/^cmd_rollback()/,/^}/p' deploy/vm/guest/fff-update | grep -qF '  portal_unit_back "$prev"' || fail "fff-update's rollback does not put back the older release's fff-portal.service (w5506)"
ok "a rollback puts back the older release's fff-portal.service"

# ---------------------------------------------------------------- the portal's agents' own account (w5598)
# The orchestrators, the dispatcher and the judge run as AGENT_USER through fff-agent.socket; the portal names it, and
# falls back to its own account without it (server/agentAccount.ts). The agent unit sees the portal's folders only
# through the views, never the secrets folder, and only its own processes in /proc.
grep -qx 'Environment=FFF_AGENT_SOCKET=/run/fff-agent/claude.sock' "$p" || fail "fff-portal.service does not name fff-agent.socket in FFF_AGENT_SOCKET"
[ "$(value "$out/fff-agent.socket" Socket ListenStream)" = /run/fff-agent/claude.sock ] || fail "fff-agent.socket does not listen where the portal looks"
[ "$(value "$out/fff-agent.socket" Socket SocketMode)" = 0600 ] && [ "$(value "$out/fff-agent.socket" Socket SocketUser)" = "$FFF_USER" ] || fail "fff-agent.socket is not the portal account's alone (0600)"
a=$out/fff-agent@.service
[ "$(value "$a" Service User)" = "$AGENT_USER" ] || fail "fff-agent@.service does not run as $AGENT_USER"
[ "$(value "$a" Service ProtectProc)" = invisible ] || fail "fff-agent@.service shows other processes in /proc"
[ "$(value "$a" Service TemporaryFileSystem)" = "$FFF_ROOT:mode=0755" ] || fail "fff-agent@.service does not empty $FFF_ROOT before its views"
! grep -nE "secrets|/etc/fff|$FFF_ROOT/home( |$)" "$a" | grep -vE '^[0-9]+:#' | grep -q . || fail "fff-agent@.service binds the secrets folder, /etc/fff or the portal's home: $(grep -nE "secrets|/etc/fff" "$a")"
{ grep -q '^agent_setup()' $G/install.sh && grep -qF 'run_cmd systemctl disable --now fff-agent.socket' $G/install.sh; } || fail "install.sh's agent step is not the non-fatal one that stops the socket on a failure"
ok "the portal's agents run as $AGENT_USER behind fff-agent.socket, in a unit that sees only its views and its own processes; install.sh falls back"
echo "all unit checks pass"
