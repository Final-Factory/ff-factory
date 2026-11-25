#!/usr/bin/env bash
# the fakes are single-quoted on purpose
# shellcheck disable=SC2016
# `fffctl agents` (w5651, the lockout review of w5598): the switch the ops worker can turn with no orchestrator. No root and
# no VM: run by lint.sh, against a fake systemctl, logger and journalctl. What it checks:
#   status names no switch at first, then the one set, the socket's state and the portal's "agent account" lines;
#   off writes "off" (the line server/agentAccount.ts agentSwitchFile reads) and stops and disables fff-agent.socket;
#   warn and on write their word and enable and start the socket; default removes the file;
#   a word that is not a mode, or a second word, changes nothing; each change is logged.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
printf '#!/bin/sh\n[ "$1" = -t ] && shift 2\n[ "$1" = -- ] && shift\necho "$*" >>"%s/logger"\n' "$tmp" >"$tmp/bin/logger"
printf '#!/bin/sh\necho "$*" >>"%s/systemctl"\ncase "$1" in is-active) echo inactive; exit 3 ;; is-enabled) echo disabled; exit 1 ;; esac\n' "$tmp" >"$tmp/bin/systemctl"
printf '#!/bin/sh\necho "2026-11-25T10:00:00+0000 fff node[1]: agent account (warn): the check passed: stub"\necho "2026-11-25T10:00:01+0000 fff node[1]: something else"\n' >"$tmp/bin/journalctl"
chmod +x "$tmp/bin/logger" "$tmp/bin/systemctl" "$tmp/bin/journalctl"
: >"$tmp/logger"
: >"$tmp/systemctl"
: >"$tmp/fff.conf"
sw=$tmp/agent-account
ctl() { FFF_TEST_NOROOT=1 FFF_LIB=$G FFF_CONF=$tmp/fff.conf FFF_AGENT_SWITCH=$sw AGENT_USER=zz-no-such-account FFF_PATH_PREFIX=$tmp/bin bash $G/fffctl agents "$@" 2>&1; }

out=$(ctl)
printf '%s\n' "$out" | matches -F "switch: none ($sw;" || fail "status without a switch: $out"
printf '%s\n' "$out" | matches -F "agent account (warn): the check passed" || fail "status shows no agent account line: $out"
! printf '%s\n' "$out" | matches -F "something else" || fail "status shows lines that are not the agent account's: $out"
printf '%s\n' "$out" | matches -F "views: the agents' account is not set up" || fail "status on a VM without the account: $out"
[ ! -e "$sw" ] || fail "status wrote the switch"
echo "ok: status reads, names no switch, shows the portal's agent account lines only"

ctl off >/dev/null || fail "agents off failed: $(ctl off)"
[ "$(cat "$sw")" = off ] || fail "off wrote $(cat "$sw")"
[ "$(stat -c %a "$sw")" = 644 ] || fail "the switch is $(stat -c %a "$sw"), not 644 (the portal's account reads it)"
matches -x "disable --now fff-agent.socket" "$tmp/systemctl" || fail "off did not stop the socket: $(cat "$tmp/systemctl")"
matches -x "agents off" "$tmp/logger" || fail "off was not logged"
ctl | matches -F "switch: off ($sw;" || fail "status after off: $(ctl)"
echo "ok: off writes off, stops and disables fff-agent.socket, is logged"

for m in warn on; do
  : >"$tmp/systemctl"
  ctl "$m" >/dev/null || fail "agents $m failed: $(ctl "$m")"
  [ "$(cat "$sw")" = "$m" ] || fail "$m wrote $(cat "$sw")"
  matches -x "enable --now fff-agent.socket" "$tmp/systemctl" || fail "$m did not start the socket: $(cat "$tmp/systemctl")"
done
echo "ok: warn and on write their word and start fff-agent.socket"

if ctl sideways >/dev/null; then fail "a word that is not a mode was taken"; fi
if ctl off now >/dev/null; then fail "a second word was taken"; fi
[ "$(cat "$sw")" = on ] || fail "a refused form changed the switch to $(cat "$sw")"
ctl default >/dev/null || fail "agents default failed"
[ ! -e "$sw" ] || fail "default left the switch"
echo "ok: a bad form changes nothing; default removes the switch"
