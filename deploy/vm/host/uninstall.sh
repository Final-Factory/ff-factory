#!/usr/bin/env bash
# Undo deploy/vm/host/install.sh on the FFBox host: the host's way back to how it was before the portal VM.
#
#   sudo deploy/vm/host/uninstall.sh --dry-run
#   sudo deploy/vm/host/uninstall.sh [--delete-disk] [--purge-packages] [--config FILE]
#
# Stops and removes the VM's definition, its network, the firewall table and every fff-vm unit and file, and puts
# libvirt's default network back as it was. It removes only what /var/lib/fff-vm/manifest says install.sh made.
# The VM's disk (and its snapshots) stays unless --delete-disk: it holds the portal's data until the migration
# back is done (docs/portal-on-ffbox-host.md, "Rollback"). Packages stay unless --purge-packages, which removes only
# those install.sh installed. /etc/fff-vm is kept as a tarball in /var/backups first.
set -o errexit -o nounset -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

CONF=/etc/fff-vm/fff-vm.conf
DELETE_DISK=0
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --config) CONF=$2; shift ;;
    --delete-disk) DELETE_DISK=1 ;;
    --purge-packages) PURGE=1 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
need_root
if [ -f "$CONF" ]; then load_conf "$CONF"; else warn "no $CONF; using the defaults"; load_conf "$here/fff-vm.conf.example"; fi
[ -f "$FFF_VM_MANIFEST" ] || warn "no manifest at $FFF_VM_MANIFEST: removing only what is marked as fff-vm's"
[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing will be changed"

have_virsh() { command -v virsh >/dev/null && v version >/dev/null 2>&1; }

log "1/6 timers and services"
for u in fff-vm-nightly.timer fff-vm-watch.timer fff-vm-events.service fff-vm-nightly.service fff-vm-watch.service; do
  if systemctl list-unit-files "$u" >/dev/null 2>&1 && systemctl cat "$u" >/dev/null 2>&1; then run_cmd systemctl disable --now "$u"; fi
done

log "2/6 the domain $VM_NAME"
if have_virsh && dom_exists; then
  dom_is_ours || refuse "the domain $VM_NAME is not fff-vm's; not touching it"
  if [ "$(dom_state)" = running ]; then
    # A clean stop: the portal records what to resume (its SIGTERM stop), then the guest powers off.
    run_cmd virsh --connect qemu:///system shutdown "$VM_NAME" --mode agent,acpi
    if [ "$DRY_RUN" != 1 ]; then
      for _ in $(seq 60); do [ "$(dom_state)" = "shut off" ] && break; sleep 5; done
      [ "$(dom_state)" = "shut off" ] || v destroy "$VM_NAME"
    fi
  fi
  run_cmd virsh --connect qemu:///system undefine "$VM_NAME"
fi

log "3/6 the disk"
disk=$(vm_disk_path)
if [ "$DELETE_DISK" = 1 ]; then
  if [ "$VM_DISK_MODE" = zvol ] && zfs list -H "$VM_ZVOL_PARENT/disk0" >/dev/null 2>&1; then
    [ "$(zfs get -H -o value fff-vm:managed "$VM_ZVOL_PARENT/disk0")" = yes ] || refuse "$VM_ZVOL_PARENT/disk0 is not fff-vm's"
    run_cmd zfs destroy -r "$VM_ZVOL_PARENT/disk0"
    if [ "$(manifest_get zfs_parent_created)" = "$VM_ZVOL_PARENT" ] && [ -z "$(zfs list -H -r -d 1 -o name "$VM_ZVOL_PARENT" | grep -vxF "$VM_ZVOL_PARENT" || true)" ]; then
      run_cmd zfs destroy "$VM_ZVOL_PARENT"
    fi
  elif [ "$VM_DISK_MODE" = qcow2 ] && [ -e "$disk" ]; then
    [ "$(manifest_get disk_created)" = "$disk" ] || refuse "$disk was not made by install.sh"
    run_cmd rm -f "$disk"
  fi
  run_cmd rm -rf "$VM_IMAGE_DIR/cache" "$VM_IMAGE_DIR/seed.iso"
  [ "$DRY_RUN" = 1 ] || rmdir "$VM_IMAGE_DIR" 2>/dev/null || true
else
  log "kept: $disk (and its snapshots). --delete-disk removes it once the portal's data is safe elsewhere"
fi

log "4/6 the network $NET_NAME and libvirt's default network"
if have_virsh && net_exists; then
  net_is_ours || refuse "the network $NET_NAME is not fff-vm's; not touching it"
  if [ "$(v net-info "$NET_NAME" | awk '/^Active:/ {print $2}')" = yes ]; then run_cmd virsh --connect qemu:///system net-destroy "$NET_NAME"; fi
  run_cmd virsh --connect qemu:///system net-undefine "$NET_NAME"
fi
if have_virsh && v net-info default >/dev/null 2>&1; then
  [ "$(manifest_get default_net_autostart)" = yes ] && run_cmd virsh --connect qemu:///system net-autostart default
  if [ "$(manifest_get default_net_active)" = yes ] && [ "$(v net-info default | awk '/^Active:/ {print $2}')" != yes ]; then
    run_cmd virsh --connect qemu:///system net-start default
  fi
fi

log "5/6 firewall table, units and files"
if systemctl cat fff-vm-firewall.service >/dev/null 2>&1; then run_cmd systemctl disable --now fff-vm-firewall.service; fi
if nft list table inet fff_vm >/dev/null 2>&1; then
  nft list table inet fff_vm | grep -qF "$FFF_VM_MARK" || refuse "the table inet fff_vm is not fff-vm's"
  run_cmd nft delete table inet fff_vm
fi
for f in /etc/systemd/system/fff-vm-firewall.service /etc/systemd/system/fff-vm-watch.service /etc/systemd/system/fff-vm-watch.timer \
  /etc/systemd/system/fff-vm-nightly.service /etc/systemd/system/fff-vm-nightly.timer /etc/systemd/system/fff-vm-events.service \
  /usr/local/sbin/fff-vm; do
  [ ! -e "$f" ] || run_cmd rm -f "$f"
done
[ ! -d /usr/local/lib/fff-vm ] || run_cmd rm -rf /usr/local/lib/fff-vm
run_cmd systemctl daemon-reload
if [ -d "$FFF_VM_ETC" ]; then
  keep="/var/backups/fff-vm-etc-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  run_cmd tar -C / -czf "$keep" "${FFF_VM_ETC#/}"
  run_cmd chmod 0600 "$keep"
  run_cmd rm -rf "$FFF_VM_ETC"
  log "the settings, keys and seed are kept in $keep (root only)"
fi

log "6/6 packages"
installed=$(manifest_get packages_installed)
if [ "$PURGE" = 1 ] && [ -n "${installed// /}" ]; then
  if have_virsh && [ -n "$(v list --all --name | grep -v '^$' || true)" ]; then
    warn "other libvirt domains exist; packages kept"
  else
    # shellcheck disable=SC2086
    run_cmd env DEBIAN_FRONTEND=noninteractive apt-get purge -y -q $installed
    run_cmd env DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q
  fi
else
  log "kept: ${installed:-none recorded}${installed:+ (--purge-packages removes them)}"
fi
if [ "$DRY_RUN" != 1 ]; then
  mv "$FFF_VM_MANIFEST" "$FFF_VM_MANIFEST.uninstalled-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
  rm -rf "$FFF_VM_RUN" "$FFF_VM_STATE/watch.state"
fi
log "uninstalled"
[ "$DRY_RUN" != 1 ] || log "DRY RUN finished: nothing was changed"
