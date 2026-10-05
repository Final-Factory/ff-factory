# shellcheck shell=bash
# Shared by the FF Factory portal VM's host scripts (deploy/vm/host). Sourced, never run.
#
# DRY_RUN=1 makes every change print instead of happen: run_cmd, write_file and the helpers built on them. Reads
# (virsh list, nft list, ip route ...) still run, so a dry run reports real conflicts.

set -o errexit -o nounset -o pipefail

FFF_VM_ETC=${FFF_VM_ETC:-/etc/fff-vm}
FFF_VM_STATE=${FFF_VM_STATE:-/var/lib/fff-vm}
FFF_VM_RUN=${FFF_VM_RUN:-/run/fff-vm}
FFF_VM_MANIFEST=${FFF_VM_MANIFEST:-$FFF_VM_STATE/manifest}
# What marks a thing as ours: the nft table's comment, the network's and the domain's <description>, a ZFS property.
FFF_VM_MARK='fff-vm: FF Factory portal VM (deploy/vm/host)'
DRY_RUN=${DRY_RUN:-0}

log() { printf '%s fff-vm: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
warn() { log "WARNING: $*"; }
die() { log "ERROR: $*"; exit 1; }
# matches ARGS...: grep that reads all of its input. "grep -q" stops at the first match, and the writer of a pipe into it
# then dies of SIGPIPE, which pipefail turns into a failure (nft 1.1 on Ubuntu 26.04 hit it).
matches() { grep "$@" >/dev/null; }
# A refusal: something on the host is not ours where we would put ours. Nothing is overridden.
refuse() { log "REFUSED: $*"; exit 3; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 ...)"; }

# run_cmd CMD ARGS...: run it, or with DRY_RUN=1 print it.
run_cmd() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY-RUN would run:' >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
  else
    "$@"
  fi
}

# write_file PATH MODE [OWNER]: content from stdin; writes only when it differs (so units are not reloaded for
# nothing). Prints "changed" on stdout when it wrote (or would write).
write_file() {
  local path=$1 mode=$2 owner=${3:-root:root} tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would write $path ($mode, $owner, $(wc -c <"$tmp") bytes)"
    rm -f "$tmp"
  else
    install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
    rm -f "$tmp"
  fi
  echo changed
}

# load_conf FILE: the operator's settings over the defaults in fff-vm.conf.example.
load_conf() {
  local file=$1 here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=fff-vm.conf.example
  . "$here/fff-vm.conf.example"
  if [ -f "$file" ]; then
    # shellcheck disable=SC1090
    . "$file"
  elif [ "$file" != "$here/fff-vm.conf.example" ]; then
    die "no config at $file (copy fff-vm.conf.example there and edit it)"
  fi
  case "$VM_DISK_MODE" in zvol | qcow2) ;; *) die "VM_DISK_MODE is zvol or qcow2, not '$VM_DISK_MODE'" ;; esac
  [ "$VM_DISK_MODE" != zvol ] || [ -n "$VM_ZVOL_PARENT" ] || die "VM_DISK_MODE=zvol needs VM_ZVOL_PARENT (a dataset, e.g. tank/fff-vm)"
  case "$NIGHTLY_MODE" in always | if-required | off) ;; *) die "NIGHTLY_MODE is always, if-required or off" ;; esac
}

# The VM's disk, as libvirt sees it.
vm_disk_path() {
  if [ "$VM_DISK_MODE" = zvol ]; then echo "/dev/zvol/$VM_ZVOL_PARENT/disk0"; else echo "$VM_IMAGE_DIR/disk0.qcow2"; fi
}

# Manifest: what install changed, so uninstall undoes exactly that. One "key=value" per line, last one wins.
manifest_get() { if [ -f "$FFF_VM_MANIFEST" ]; then grep -E "^$1=" "$FFF_VM_MANIFEST" | tail -n 1 | cut -d= -f2- || true; fi; }
manifest_set() {
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would record $1=$2 in $FFF_VM_MANIFEST"; return 0; fi
  mkdir -p "$(dirname "$FFF_VM_MANIFEST")"
  echo "$1=$2" >>"$FFF_VM_MANIFEST"
}

# notify TITLE MESSAGE: an ntfy push to the topic FF Factory's outside watch uses (NTFY_URL_FILE holds the whole URL).
# The URL is a secret of sorts (anyone with it can read the alerts): never printed.
notify() {
  local title=$1 msg=$2
  log "notify: $title: $msg"
  [ "$DRY_RUN" = 1 ] && return 0
  [ -r "${NTFY_URL_FILE:-}" ] || { warn "no $NTFY_URL_FILE; alert not sent"; return 0; }
  curl -fsS -m 20 -o /dev/null -H "Title: $title" -H 'Priority: high' -H 'Tags: warning' --data-binary "$msg" "$(head -n 1 "$NTFY_URL_FILE")" ||
    warn "ntfy push failed"
}

# virsh against the system instance, never a user session's.
v() { virsh --connect qemu:///system "$@"; }

dom_exists() { v dominfo "$VM_NAME" >/dev/null 2>&1; }
dom_state() { v domstate "$VM_NAME" 2>/dev/null | head -n 1 || echo missing; }
dom_is_ours() { v dumpxml "$VM_NAME" 2>/dev/null | matches -F "$FFF_VM_MARK"; }
net_exists() { v net-info "$NET_NAME" >/dev/null 2>&1; }
net_is_ours() { v net-dumpxml "$NET_NAME" 2>/dev/null | matches -F "<bridge name='$NET_BRIDGE'" && v net-dumpxml "$NET_NAME" | matches -F "address='$NET_HOST_IP'"; }

# guest_agent JSON: a guest agent command; prints its "return" (jq), fails when the agent does not answer.
guest_agent() { v qemu-agent-command "$VM_NAME" "$1" --timeout "${2:-10}" 2>/dev/null | jq -c '.return'; }

# guest_exec TIMEOUT PATH ARG...: run a program in the guest through the agent, wait for it; prints its stdout,
# returns its exit code (124 on timeout, 125 when the agent did not take it).
guest_exec() {
  local timeout=$1 path=$2 args pid status deadline
  shift 2
  args=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  pid=$(guest_agent "$(jq -nc --arg p "$path" --argjson a "$args" '{execute:"guest-exec",arguments:{path:$p,arg:$a,"capture-output":true}}')" 30 | jq -r '.pid // empty') || true
  [ -n "$pid" ] || return 125
  deadline=$(($(date +%s) + timeout))
  while :; do
    status=$(guest_agent "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$pid}}" 10) || status='{}'
    if [ "$(jq -r '.exited // false' <<<"$status")" = true ]; then
      jq -r '."out-data" // empty' <<<"$status" | base64 -d 2>/dev/null || true
      return "$(jq -r '.exitcode // 1' <<<"$status")"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 124
    sleep 5
  done
}

portal_healthy() { curl -fsS -m 10 -o /dev/null "http://$NET_VM_IP:$PORTAL_PORT/api/health"; }
