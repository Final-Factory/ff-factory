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
  # install.sh asks for VM_ZVOL_PARENT when it is missing (LOAD_CONF_PARTIAL=1), and checks it after the questions.
  [ "${LOAD_CONF_PARTIAL:-0}" = 1 ] || [ "$VM_DISK_MODE" != zvol ] || [ -n "$VM_ZVOL_PARENT" ] || die "VM_DISK_MODE=zvol needs VM_ZVOL_PARENT (a dataset, e.g. tank/fff-vm)"
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

# ---------------------------------------------------------------- the domain's definition (w537)
# Made from fff-vm.conf by domain_xml, here, for both: install.sh defines it for a new VM or one that is off, and fff-vm
# nightly applies a change to a running VM's while it is off at the cold restart, with the previous one to fall back on.
vm_seed_iso() { echo "$VM_IMAGE_DIR/seed.iso"; }

# domain_xml: the VM's libvirt definition, from fff-vm.conf.
domain_xml() {
  local disk seed_iso disk_xml
  disk=$(vm_disk_path)
  seed_iso=$(vm_seed_iso)
  if [ "$VM_DISK_MODE" = zvol ]; then
    disk_xml="<disk type='block' device='disk'><driver name='qemu' type='raw' cache='none' io='native' discard='unmap'/><source dev='$disk'/><target dev='vda' bus='virtio'/></disk>"
  else
    disk_xml="<disk type='file' device='disk'><driver name='qemu' type='qcow2' discard='unmap'/><source file='$disk'/><target dev='vda' bus='virtio'/></disk>"
  fi
  cat <<EOF
<domain type='kvm'>
  <name>$VM_NAME</name>
  <description>$FFF_VM_MARK</description>
  <memory unit='MiB'>$VM_MEMORY_MB</memory>
  <currentMemory unit='MiB'>$VM_MEMORY_MB</currentMemory>
  <vcpu placement='static'>$VM_VCPUS</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough' check='none'/>
  <clock offset='utc'>
    <timer name='rtc' tickpolicy='catchup'/>
    <timer name='pit' tickpolicy='delay'/>
    <timer name='hpet' present='no'/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>restart</on_crash>
  <pm><suspend-to-mem enabled='no'/><suspend-to-disk enabled='no'/></pm>
  <devices>
    $disk_xml
    <disk type='file' device='cdrom'><driver name='qemu' type='raw'/><source file='$seed_iso'/><target dev='sda' bus='sata'/><readonly/></disk>
    <interface type='network'><mac address='$NET_VM_MAC'/><source network='$NET_NAME'/><model type='virtio'/></interface>
    <serial type='pty'><log file='/var/log/libvirt/qemu/$VM_NAME-serial.log' append='on'/><target port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>
    <watchdog model='i6300esb' action='reset'/>
    <panic model='isa'/>
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
    <memballoon model='virtio'/>
  </devices>
</domain>
EOF
}

# domain_define FILE: virsh define it. An existing domain keeps its uuid: libvirt refuses a definition without one for a
# name it knows ("domain 'fff-portal' already exists with uuid ..."; measured with libvirt 10.0's test driver, w537).
domain_define() {
  local file=$1 uuid tmp rc=0
  uuid=$(v domuuid "$VM_NAME" 2>/dev/null | head -n 1 | tr -d ' ' || true)
  tmp=$(mktemp)
  if [ -n "$uuid" ] && ! matches '<uuid>' "$file"; then
    sed "s|^\( *<name>.*</name>\)\$|\1\n  <uuid>$uuid</uuid>|" "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
  fi
  run_cmd virsh --connect qemu:///system define "$tmp" || rc=$?
  rm -f "$tmp"
  return "$rc"
}

# dom_size [--inactive]: "MEMORY_MIB VCPUS" of the domain as it runs (or, --inactive, as it starts next); nothing when
# there is no domain. libvirt keeps the memory in KiB.
dom_size() {
  { v dumpxml "$@" "$VM_NAME" 2>/dev/null || true; } |
    awk -F'[<>]' '$2 ~ /^memory( |$)/ {m = int($3 / 1024)} $2 ~ /^vcpu( |$)/ {c = $3} END {if (m != "" && c != "") print m, c}'
}

# domain_ident: the disk, seed, network and MAC address a definition (on stdin) names. A change there is install.sh's
# to make (a disk made, a network, the guest's first-boot network config), never the nightly's.
domain_ident() { { grep -oE "<source (file|dev|network)='[^']*'|<mac address='[^']*'" || true; } | tr '[:upper:]' '[:lower:]' | sort | paste -sd' ' -; }

# domain_changes: what the definition from fff-vm.conf changes in the domain's next start, one phrase per line; nothing
# when they match or there is no domain. The size is compared with libvirt's own definition; the rest with the
# definition last given to libvirt ($FFF_VM_ETC/domain.xml), which changes only with the scripts' own template.
domain_changes() {
  local have stored=$FFF_VM_ETC/domain.xml sizes="<(memory|currentMemory|vcpu)[ >]"
  have=$(dom_size --inactive)
  [ -n "$have" ] || return 0
  [ "${have% *}" = "$VM_MEMORY_MB" ] || echo "memory ${have% *} -> $VM_MEMORY_MB MiB"
  [ "${have#* }" = "$VM_VCPUS" ] || echo "vCPUs ${have#* } -> $VM_VCPUS"
  if [ ! -f "$stored" ] || [ "$(grep -vE "$sizes" "$stored")" != "$(domain_xml | grep -vE "$sizes")" ]; then
    echo "the rest of the definition (the scripts' template, against $stored)"
  fi
}

# domain_foreign: "<now> -> <fff-vm.conf's>" when fff-vm.conf names another disk, seed, network or MAC address than the
# domain's definition; nothing when they are the same.
domain_foreign() {
  local have want
  have=$({ v dumpxml --inactive "$VM_NAME" 2>/dev/null || true; } | domain_ident)
  want=$(domain_xml | domain_ident)
  [ "$have" = "$want" ] || echo "$have -> $want"
}
