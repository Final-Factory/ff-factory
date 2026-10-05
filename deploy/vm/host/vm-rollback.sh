#!/usr/bin/env bash
# Put the portal VM's disk back to one of its snapshots (the nightly ones, taken while the VM was off).
#
#   sudo deploy/vm/host/vm-rollback.sh --list
#   sudo deploy/vm/host/vm-rollback.sh --dry-run fff-nightly-20261005-1200
#   sudo deploy/vm/host/vm-rollback.sh --yes fff-nightly-20261005-1200
#
# Everything the VM wrote after that snapshot is set aside, not deleted: a zvol's current state is kept as the
# volume <parent>/disk0-before-rollback-<time> (zfs clone, rename and promote), a qcow2's as an internal snapshot
# fff-before-rollback-<time>. The portal is drained first, as at the nightly restart. For the portal's code alone,
# "fffctl rollback" inside the VM is enough; this is for a guest whose OS or data went wrong.
set -o errexit -o nounset -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
CONF=/etc/fff-vm/fff-vm.conf
YES=0
LIST=0
SNAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --list) LIST=1 ;;
    --config) CONF=$2; shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) SNAP=$1 ;;
  esac
  shift
done
need_root
load_conf "$CONF"
disk=$(vm_disk_path)
list() {
  if [ "$VM_DISK_MODE" = zvol ]; then zfs list -H -t snapshot -o name,creation -s creation "$VM_ZVOL_PARENT/disk0" | sed 's/^[^@]*@//'
  else qemu-img snapshot -l "$disk" | awk 'NR > 2 {print $2, $4, $5}'; fi
}
if [ "$LIST" = 1 ] || [ -z "$SNAP" ]; then list; exit 0; fi
list | awk '{print $1}' | grep -qxF "$SNAP" || die "no snapshot $SNAP (--list)"
[ "$DRY_RUN" = 1 ] || [ "$YES" = 1 ] || die "this puts the VM back to $SNAP; everything after it is set aside. Add --yes (or --dry-run)"
stamp=$(date -u +%Y%m%d-%H%M)
mkdir -p "$FFF_VM_RUN"
if [ "$DRY_RUN" != 1 ]; then
  touch "$FFF_VM_RUN/maintenance"
  trap 'rm -f "$FFF_VM_RUN/maintenance"' EXIT
fi

if [ "$(dom_state)" = running ]; then
  log "draining the portal, then stopping the VM"
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would run fffctl prepare-shutdown in the guest and stop $VM_NAME"
  else
    guest_exec 900 /usr/local/sbin/fffctl prepare-shutdown --drain-minutes 10 --reason "disk rollback to $SNAP" || warn "the drain did not finish; stopping anyway"
    v shutdown "$VM_NAME" --mode agent,acpi >/dev/null 2>&1 || true
    for _ in $(seq 60); do [ "$(dom_state)" = "shut off" ] && break; sleep 5; done
    [ "$(dom_state)" = "shut off" ] || v destroy "$VM_NAME"
  fi
fi
if [ "$VM_DISK_MODE" = zvol ]; then
  p=$VM_ZVOL_PARENT
  run_cmd zfs clone -o fff-vm:managed=yes "$p/disk0@$SNAP" "$p/disk0-rollback-$stamp"
  run_cmd zfs rename "$p/disk0" "$p/disk0-before-rollback-$stamp"
  run_cmd zfs rename "$p/disk0-rollback-$stamp" "$p/disk0"
  run_cmd zfs promote "$p/disk0"
  log "the state before the rollback is kept as $p/disk0-before-rollback-$stamp (zfs destroy it when no longer needed)"
else
  run_cmd qemu-img snapshot -c "fff-before-rollback-$stamp" "$disk"
  run_cmd qemu-img snapshot -a "$SNAP" "$disk"
  log "the state before the rollback is kept as the snapshot fff-before-rollback-$stamp"
fi
run_cmd virsh --connect qemu:///system start "$VM_NAME"
log "done: $VM_NAME starts from $SNAP"
