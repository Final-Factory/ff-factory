#!/usr/bin/env bash
# Install the FF Factory portal VM on the FFBox host (docs/portal-on-ffbox-host.md). Run by Lothsahn as root:
#
#   sudo deploy/vm/host/install.sh --dry-run           # what it would do, and any conflict, changing nothing
#   sudo deploy/vm/host/install.sh                     # do it (again: idempotent)
#   options: --config FILE (default /etc/fff-vm/fff-vm.conf)  --no-start (define, do not start)  --wait (until the
#            guest agent answers)
#
# It installs KVM, QEMU and libvirt; an isolated libvirt network with NAT out to the internet only; an nftables table
# that keeps the VM away from the host's services, FFBox's containers and the LAN, and everything on the host but root
# away from the VM; the VM itself from an Ubuntu cloud image with cloud-init; hang detection, the nightly reboot and
# the event alerts. It touches nothing of FFBox's: no unit, user, group, Docker setting, config or data of it, and no
# nftables table but its own. Where something it would create already exists and is not its own, it stops (exit 3).
# Everything it changes is recorded in /var/lib/fff-vm/manifest for uninstall.sh.
set -o errexit -o nounset -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

CONF=/etc/fff-vm/fff-vm.conf
START=1
WAIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --config) CONF=$2; shift ;;
    --no-start) START=0 ;;
    --wait) WAIT=1 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
need_root
if [ -f "$CONF" ]; then load_conf "$CONF"; else
  [ "$DRY_RUN" = 1 ] || die "no config at $CONF: copy $here/fff-vm.conf.example there and edit it (at least VM_ZVOL_PARENT, or VM_DISK_MODE=qcow2)"
  warn "no config at $CONF; the dry run uses the defaults in fff-vm.conf.example"
  load_conf "$here/fff-vm.conf.example"
fi
[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing will be changed"

# ---------------------------------------------------------------- 1. preflight
log "1/10 preflight"
[ "$(uname -m)" = x86_64 ] || die "x86_64 only (this is $(uname -m))"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu only (this is ${PRETTY_NAME:-unknown})"
log "host: $PRETTY_NAME, kernel $(uname -r), $(nproc) CPUs, $(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo) RAM"
matches -Ew 'vmx|svm' /proc/cpuinfo || die "the CPU shows no hardware virtualization (vmx/svm): turn on VT-x/AMD-V in the firmware"
command -v systemctl >/dev/null || die "systemd is required"
mem_free_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_free_mb" -lt $((VM_MEMORY_MB + 2048)) ] && ! dom_exists 2>/dev/null; then
  warn "only $mem_free_mb MiB available now; the VM takes $VM_MEMORY_MB MiB (plus QEMU's own, about 300 MiB)"
fi

# ---------------------------------------------------------------- 2. conflicts that need no libvirt
log "2/10 conflicts on the host (refuse rather than override)"
if command -v nft >/dev/null; then
  if nft list table inet fff_vm >/dev/null 2>&1 && ! nft list table inet fff_vm | matches -F "$FFF_VM_MARK"; then
    refuse "an nftables table 'inet fff_vm' exists and is not this installer's"
  fi
  log "nftables tables now: $(nft list tables 2>/dev/null | tr '\n' ';' || true)"
  if nft list ruleset 2>/dev/null | matches -E 'hook forward .*policy drop'; then
    warn "a forward chain on this host drops by default; libvirt adds its own accept rules for the VM's NAT, check that the VM reaches the internet (the dry run of the guest install does)"
  fi
fi
if systemctl is-enabled nftables.service >/dev/null 2>&1 && matches 'flush ruleset' /etc/nftables.conf 2>/dev/null; then
  warn "nftables.service is enabled and /etc/nftables.conf flushes the whole ruleset: a reload of it also drops the VM's isolation table. fff-vm watch puts it back within a minute and alerts; nothing here edits /etc/nftables.conf"
fi
# The subnet must be free: no address or route of the host in it, unless it is our bridge's.
subnet="${NET_HOST_IP%.*}.0/$NET_PREFIX"
if ip -4 -o addr show | grep -v " $NET_BRIDGE " | matches -F " ${NET_HOST_IP%.*}."; then
  refuse "an interface other than $NET_BRIDGE already has an address in ${NET_HOST_IP%.*}.0/$NET_PREFIX; pick another NET_HOST_IP/NET_VM_IP"
fi
if ip -4 route show | grep -v "dev $NET_BRIDGE" | matches -E "^${NET_HOST_IP%.*}\.0/"; then
  refuse "a route for $subnet exists on another interface"
fi
# A wider route that covers the subnet (a VPN's 10.0.0.0/8, say) is shadowed by the bridge's own /24 for the VM's
# addresses: say so, the network behind it loses those 256 addresses on this host.
via=$(ip -4 route get "$NET_VM_IP" 2>/dev/null | head -n 1 || true)
default_dev=$(ip -4 route show default | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
case "$via" in *" dev $NET_BRIDGE "* | *" dev $default_dev "*) ;; *) warn "the host routes $NET_VM_IP through '$via', not its default route: a route covers $subnet" ;; esac
if ip link show "$NET_BRIDGE" >/dev/null 2>&1 && ! { command -v virsh >/dev/null && net_exists && net_is_ours; }; then
  refuse "an interface named $NET_BRIDGE exists and is not the bridge of this installer's libvirt network $NET_NAME"
fi
if [ "$VM_DISK_MODE" = zvol ]; then
  command -v zfs >/dev/null || die "VM_DISK_MODE=zvol, but there is no zfs command"
  pool=${VM_ZVOL_PARENT%%/*}
  zpool list -H -o name "$pool" >/dev/null 2>&1 || die "no ZFS pool '$pool' (VM_ZVOL_PARENT=$VM_ZVOL_PARENT)"
  if zfs list -H "$VM_ZVOL_PARENT/disk0" >/dev/null 2>&1 && [ "$(zfs get -H -o value fff-vm:managed "$VM_ZVOL_PARENT/disk0")" != yes ]; then
    refuse "$VM_ZVOL_PARENT/disk0 exists and is not this installer's (no fff-vm:managed=yes)"
  fi
  if zfs list -H "$VM_ZVOL_PARENT" >/dev/null 2>&1 && [ "$(zfs get -H -o value fff-vm:managed "$VM_ZVOL_PARENT")" != yes ] &&
    [ -n "$(zfs list -H -r -d 1 -o name "$VM_ZVOL_PARENT" | grep -vxF "$VM_ZVOL_PARENT" | grep -vxF "$VM_ZVOL_PARENT/disk0" || true)" ]; then
    refuse "$VM_ZVOL_PARENT already holds other datasets; give the VM a dataset of its own"
  fi
  avail=$(zfs get -H -p -o value available "$pool")
  if ! zfs list -H "$VM_ZVOL_PARENT/disk0" >/dev/null 2>&1 && [ "$avail" -lt $((VM_DISK_GB * 1073741824 * 11 / 10)) ]; then
    die "pool $pool has $((avail / 1073741824)) GiB available; the VM's volume reserves $VM_DISK_GB GiB plus room for snapshots"
  fi
elif [ -e "$(vm_disk_path)" ] && [ "$(manifest_get disk_created)" != "$(vm_disk_path)" ]; then
  refuse "$(vm_disk_path) exists and was not made by this installer"
fi
# Accounts that could reach the VM's disk or control libvirt: root only, unless Lothsahn says otherwise.
for g in libvirt disk; do
  members=$(getent group "$g" | cut -d: -f4 || true)
  [ -z "$members" ] || warn "group $g has members ($members): they can $([ "$g" = libvirt ] && echo 'control every VM through libvirt' || echo 'read raw disks such as the VM volume'). No FFBox account may be in it"
done

# ---------------------------------------------------------------- 3. packages
log "3/10 packages"
# ubuntu-keyring holds /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg (ubuntu-cloudimage-keyring is a dummy since noble).
pkgs=(qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients cloud-image-utils ubuntu-keyring gpgv nftables jq curl)
missing=()
for p in "${pkgs[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | matches 'install ok installed' || missing+=("$p"); done
libvirt_was_installed=yes
dpkg-query -W -f='${Status}' libvirt-daemon-system 2>/dev/null | matches 'install ok installed' || libvirt_was_installed=no
[ -n "$(manifest_get libvirt_preinstalled)" ] || manifest_set libvirt_preinstalled "$libvirt_was_installed"
if [ ${#missing[@]} -gt 0 ]; then
  log "installing: ${missing[*]}"
  run_cmd env DEBIAN_FRONTEND=noninteractive apt-get update -q
  run_cmd env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
  manifest_set packages_installed "$(manifest_get packages_installed) ${missing[*]}"
else
  log "all present: ${pkgs[*]}"
fi
if [ "$DRY_RUN" != 1 ]; then
  [ -e /dev/kvm ] || modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
  [ -e /dev/kvm ] || die "/dev/kvm is missing after loading the kvm modules"
  systemctl is-active --quiet libvirtd.service || systemctl is-active --quiet virtqemud.service || systemctl start libvirtd.service
fi

# ---------------------------------------------------------------- 4. conflicts inside libvirt
log "4/10 conflicts in libvirt"
if command -v virsh >/dev/null && v version >/dev/null 2>&1; then
  if net_exists && ! net_is_ours; then refuse "a libvirt network named $NET_NAME exists and is not this installer's"; fi
  if dom_exists && ! dom_is_ours; then refuse "a libvirt domain named $VM_NAME exists and is not this installer's"; fi
  other=$(v net-list --all --name | grep -v -e '^$' -e "^$NET_NAME\$" || true)
  for n in $other; do
    if v net-dumpxml "$n" | matches -E "address='${NET_HOST_IP%.*}\.[0-9]+'"; then refuse "libvirt network $n uses ${NET_HOST_IP%.*}.0/$NET_PREFIX"; fi
  done
  # Ports: libvirt's remote access (16509 plain, 16514 TLS) would let anyone who reaches the host, ffdev included,
  # try to control the VM. This install opens no port of its own and needs none.
  if ss -Hltn '( sport = :16509 or sport = :16514 )' 2>/dev/null | matches .; then
    refuse "libvirtd listens on TCP (16509/16514): turn its remote access off (libvirtd-tcp.socket, libvirtd-tls.socket) first"
  fi
  log "libvirt networks: $(v net-list --all --name | grep -v '^$' | tr '\n' ' ')"
  log "libvirt domains: $(v list --all --name | grep -v '^$' | tr '\n' ' ')"
  if v dominfo "$VM_NAME" >/dev/null 2>&1; then :; elif v list --all --name | grep -v '^$' | matches .; then
    warn "other libvirt domains exist on this host; the VM's firewall table applies to $NET_BRIDGE only"
  fi
else
  log "libvirt is not installed yet: nothing of it to conflict with"
fi

# ---------------------------------------------------------------- 5. firewall
log "5/10 firewall (table inet fff_vm, before the network starts)"
# Connected networks of the host (its LAN included, whatever its addresses), blocked for the VM as well as the
# private ranges: a LAN on public addresses is still Lothsahn's LAN.
# Those already inside a private range are left out, so the set holds no overlapping intervals.
is_private4() {
  local a b
  IFS=. read -r a b _ <<<"${1%%/*}"
  case $a in
    0 | 10 | 127) return 0 ;;
    169) [ "$b" = 254 ] ;;
    172) [ "$b" -ge 16 ] && [ "$b" -le 31 ] ;;
    192) [ "$b" = 168 ] ;;
    100) [ "$b" -ge 64 ] && [ "$b" -le 127 ] ;;
    *) return 1 ;;
  esac
}
connected=""
for n in $(ip -4 route show scope link | awk -v br="$NET_BRIDGE" '$0 !~ ("dev " br " ") && $1 ~ /\// {print $1}' | sort -u); do
  if ! is_private4 "$n"; then connected+="${connected:+, }$n"; fi
done
blocked="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4${connected:+, $connected}${NET_EXTRA_BLOCK:+, $NET_EXTRA_BLOCK}"
run_cmd install -d -m 0755 "$FFF_VM_ETC"
nft_text=$(cat <<EOF
#!/usr/sbin/nft -f
# Generated by deploy/vm/host/install.sh: the isolation of the FF Factory portal VM (docs/portal-on-ffbox-host.md,
# "Network"). Loaded by fff-vm-firewall.service; checked every minute by fff-vm watch. Only ever this table:
# nothing here flushes or edits any other table (FFBox's, libvirt's, the host's).
table inet fff_vm
delete table inet fff_vm
table inet fff_vm {
  comment "$FFF_VM_MARK"

  set blocked4 {
    type ipv4_addr
    flags interval
    auto-merge
    elements = { $blocked }
  }

  # The VM reaches no service on the host: not sshd, not FFBox's web page, intake, model proxy or connector, and
  # no DHCP or DNS (the guest has a static address and public resolvers). Only replies to root's own checks.
  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "$NET_BRIDGE" ct state established,related accept
    iifname "$NET_BRIDGE" counter drop comment "fff-vm: the VM reaches no host service"
  }

  # Out of the VM: the internet only, never the LAN, the host's other networks or a private range. Into the VM:
  # nothing that it did not start. libvirt's own rules then accept and NAT what is left.
  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    oifname "$NET_BRIDGE" ct state established,related accept
    oifname "$NET_BRIDGE" counter drop comment "fff-vm: nothing is forwarded into the VM"
    iifname "$NET_BRIDGE" meta nfproto ipv6 counter drop comment "fff-vm: no IPv6 out of the VM"
    iifname "$NET_BRIDGE" ip saddr != $NET_VM_IP counter drop comment "fff-vm: only the VM's own address"
    iifname "$NET_BRIDGE" ip daddr @blocked4 counter drop comment "fff-vm: no LAN, host or private address"
  }

  # From the host to the VM: root only (the health check and "fff-vm ssh"), to the portal's port and ssh. FFBox's
  # rootless containers reach the outside through sockets of FFBox's own account here, so this drops them too.
  chain output {
    type filter hook output priority filter - 10; policy accept;
    oifname "$NET_BRIDGE" ct state established,related accept
    oifname "$NET_BRIDGE" meta skuid 0 ip daddr $NET_VM_IP tcp dport { 22, $PORTAL_PORT } accept
    oifname "$NET_BRIDGE" counter drop comment "fff-vm: nobody but root on the host reaches the VM"
  }
}
EOF
)
# Checked by nft itself before it is written (nft -c changes nothing; it needs nft, which a dry run may not have yet).
if command -v nft >/dev/null; then
  tmp=$(mktemp)
  printf '%s\n' "$nft_text" >"$tmp"
  nft -c -f "$tmp" || { rm -f "$tmp"; die "nft refused the generated table"; }
  rm -f "$tmp"
  log "nft accepts the table"
else
  log "nft is not installed yet: the table is checked when it loads"
fi
nft_changed=$(printf '%s\n' "$nft_text" | write_file "$FFF_VM_ETC/fff-vm.nft" 0600)
unit_changed=$(write_file /etc/systemd/system/fff-vm-firewall.service 0644 <"$here/units/fff-vm-firewall.service")
if [ -n "$unit_changed" ]; then run_cmd systemctl daemon-reload; fi
run_cmd systemctl enable fff-vm-firewall.service
if [ -n "$nft_changed$unit_changed" ] || ! nft list table inet fff_vm >/dev/null 2>&1; then
  run_cmd systemctl reload-or-restart fff-vm-firewall.service
fi
[ "$DRY_RUN" = 1 ] || nft list table inet fff_vm | matches -F "$FFF_VM_MARK" || die "the firewall table did not load"

# ---------------------------------------------------------------- 6. the isolated network
log "6/10 network $NET_NAME ($NET_BRIDGE, ${NET_HOST_IP%.*}.0/$NET_PREFIX, NAT, no DHCP, no DNS)"
net_xml=$(cat <<EOF
<network>
  <name>$NET_NAME</name>
  <description>$FFF_VM_MARK</description>
  <forward mode='nat'/>
  <bridge name='$NET_BRIDGE' stp='on' delay='0'/>
  <dns enable='no'/>
  <ip address='$NET_HOST_IP' prefix='$NET_PREFIX'/>
</network>
EOF
)
if ! net_exists; then
  tmp=$(mktemp); echo "$net_xml" >"$tmp"
  run_cmd virsh --connect qemu:///system net-define "$tmp"
  rm -f "$tmp"
  manifest_set network_created "$NET_NAME"
fi
run_cmd virsh --connect qemu:///system net-autostart "$NET_NAME"
if [ "$DRY_RUN" = 1 ] || [ "$(v net-info "$NET_NAME" | awk '/^Active:/ {print $2}')" != yes ]; then
  run_cmd virsh --connect qemu:///system net-start "$NET_NAME"
fi
if [ "$DRY_RUN" != 1 ] && pgrep -af dnsmasq | matches "$NET_NAME"; then warn "a dnsmasq runs for $NET_NAME although DHCP and DNS are off"; fi

# ---------------------------------------------------------------- 7. libvirt's default network
log "7/10 libvirt's default network (DEFAULT_NET_ACTION=$DEFAULT_NET_ACTION)"
if command -v virsh >/dev/null && v net-info default >/dev/null 2>&1; then
  users=$(for d in $(v list --all --name); do v dumpxml "$d" | matches "<source network='default'" && echo "$d"; done || true)
  act=$DEFAULT_NET_ACTION
  if [ "$act" = auto ]; then
    if [ "$(manifest_get libvirt_preinstalled)" = no ] && [ -z "$users" ]; then act=disable; else act=leave; fi
  fi
  if [ "$act" = disable ]; then
    [ -z "$users" ] || refuse "DEFAULT_NET_ACTION=disable, but domains use the default network: $users"
    [ -n "$(manifest_get default_net_autostart)" ] || manifest_set default_net_autostart "$(v net-info default | awk '/^Autostart:/ {print $2}')"
    [ -n "$(manifest_get default_net_active)" ] || manifest_set default_net_active "$(v net-info default | awk '/^Active:/ {print $2}')"
    run_cmd virsh --connect qemu:///system net-autostart default --disable
    if [ "$(v net-info default | awk '/^Active:/ {print $2}')" = yes ]; then run_cmd virsh --connect qemu:///system net-destroy default; fi
    log "default network stopped and off at boot (uninstall.sh puts it back)"
  else
    log "default network left as it is ($(v net-info default | awk '/^Active:|^Autostart:/ {printf "%s %s ", $1, $2}'))"
  fi
else
  log "no default network"
fi

# ---------------------------------------------------------------- 8. the disk
log "8/10 disk ($VM_DISK_MODE, $VM_DISK_GB GiB) from the Ubuntu $VM_OS_VERSION cloud image"
disk=$(vm_disk_path)
run_cmd install -d -m 0711 "$VM_IMAGE_DIR"
disk_exists=no
if [ "$VM_DISK_MODE" = zvol ]; then
  if zfs list -H "$VM_ZVOL_PARENT/disk0" >/dev/null 2>&1; then disk_exists=yes; fi
elif [ -e "$disk" ]; then
  disk_exists=yes
fi
if [ "$disk_exists" = yes ]; then
  log "the disk exists ($disk): left as it is (never overwritten; grow it by hand)"
else
  img="ubuntu-$VM_OS_VERSION-server-cloudimg-amd64.img"
  url="https://cloud-images.ubuntu.com/releases/$VM_OS_RELEASE/release"
  cache="$VM_IMAGE_DIR/cache"
  run_cmd install -d -m 0700 "$cache"
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would download $url/$img, check SHA256SUMS against Ubuntu's cloud image key, and write it to $disk"
  else
    curl -fsSL -o "$cache/SHA256SUMS" "$url/SHA256SUMS"
    curl -fsSL -o "$cache/SHA256SUMS.gpg" "$url/SHA256SUMS.gpg"
    gpgv --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg "$cache/SHA256SUMS.gpg" "$cache/SHA256SUMS" 2>/dev/null ||
      die "SHA256SUMS is not signed by Ubuntu's cloud image key"
    want=$(awk -v f="$img" '$2 == f || $2 == "*" f {print $1}' "$cache/SHA256SUMS")
    [ -n "$want" ] || die "$img is not in SHA256SUMS"
    if [ ! -f "$cache/$img" ] || [ "$(sha256sum "$cache/$img" | cut -d' ' -f1)" != "$want" ]; then
      curl -fSL --retry 3 -o "$cache/$img.part" "$url/$img"
      mv "$cache/$img.part" "$cache/$img"
    fi
    [ "$(sha256sum "$cache/$img" | cut -d' ' -f1)" = "$want" ] || die "$img does not match its SHA256SUMS line"
    log "image verified: $img sha256 $want"
    if [ "$VM_DISK_MODE" = zvol ]; then
      if ! zfs list -H "$VM_ZVOL_PARENT" >/dev/null 2>&1; then
        zfs create -p -o fff-vm:managed=yes "$VM_ZVOL_PARENT"
        manifest_set zfs_parent_created "$VM_ZVOL_PARENT"
      fi
      # Not sparse: the volume's full size is reserved in the pool, so neither FFBox nor the VM can fill the other.
      zfs create -V "${VM_DISK_GB}G" -o volblocksize=16K -o compression=lz4 -o fff-vm:managed=yes "$VM_ZVOL_PARENT/disk0"
      udevadm settle
      for _ in $(seq 30); do [ -e "$disk" ] && break; sleep 1; done
      qemu-img convert -f qcow2 -O raw -n --target-is-zero "$cache/$img" "$disk"
    else
      qemu-img convert -f qcow2 -O qcow2 "$cache/$img" "$disk.part"
      qemu-img resize -q "$disk.part" "${VM_DISK_GB}G"
      chmod 0600 "$disk.part"
      mv "$disk.part" "$disk"
    fi
    manifest_set disk_created "$disk"
  fi
fi

# ---------------------------------------------------------------- 9. cloud-init seed and the domain
log "9/10 cloud-init seed and the domain $VM_NAME"
run_cmd install -d -m 0700 "$FFF_VM_ETC/ssh"
if [ ! -f "$FFF_VM_ETC/ssh/id_ed25519" ]; then
  run_cmd ssh-keygen -q -t ed25519 -N '' -C "root@$(hostname -s) fff-vm" -f "$FFF_VM_ETC/ssh/id_ed25519"
fi
keys=$( {
  cat "$FFF_VM_ETC/ssh/id_ed25519.pub" 2>/dev/null || echo "ssh-ed25519 AAAA-dry-run-key root@host"
  if [ -f "$VM_ADMIN_KEYS_FILE" ]; then grep -E '^(ssh-|ecdsa-|sk-)' "$VM_ADMIN_KEYS_FILE" || true; fi
} | sed 's/^/      - /')
instance_id=$(manifest_get instance_id)
if [ -z "$instance_id" ]; then instance_id="$VM_NAME-$(date -u +%Y%m%d%H%M%S)"; manifest_set instance_id "$instance_id"; fi
# The guest's apt timers run before the nightly reboot (UPGRADE_LEAD_MIN), in the reboot's time zone.
nightly_min=$((10#${NIGHTLY_TIME%%:*} * 60 + 10#${NIGHTLY_TIME##*:}))
at_min() { local m=$(((nightly_min - $1 + 1440) % 1440)); printf '%02d:%02d' $((m / 60)) $((m % 60)); }
upgrade_at=$(at_min "$UPGRADE_LEAD_MIN")
update_at=$(at_min $((UPGRADE_LEAD_MIN + 30)))
dns_yaml=$(for d in $GUEST_DNS; do printf '%s, ' "$d"; done | sed 's/, $//')
seed="$FFF_VM_ETC/seed"
run_cmd install -d -m 0700 "$seed"
c1=$(write_file "$seed/meta-data" 0600 <<EOF
instance-id: $instance_id
local-hostname: $VM_NAME
EOF
)
c2=$(write_file "$seed/network-config" 0600 <<EOF
version: 2
ethernets:
  primary:
    match:
      macaddress: "$NET_VM_MAC"
    addresses: [$NET_VM_IP/$NET_PREFIX]
    routes:
      - to: default
        via: $NET_HOST_IP
    nameservers:
      addresses: [$dns_yaml]
EOF
)
c3=$(write_file "$seed/user-data" 0600 <<EOF
#cloud-config
# $FFF_VM_MARK. Generated by install.sh; read once, at the first boot of instance $instance_id.
hostname: $VM_NAME
timezone: $VM_TIMEZONE
ssh_pwauth: false
disable_root: true
users:
  - name: $VM_ADMIN_USER
    gecos: FF Factory VM admin
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: true
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
    ssh_authorized_keys:
$keys
package_update: true
package_upgrade: true
# linux-image-extra-virtual: the cloud image's kernel has no i6300esb module (it is in linux-modules-extra). When the
# upgrade brought a new kernel, cloud-init reboots once into it before runcmd, so the module matches the kernel.
packages: [qemu-guest-agent, unattended-upgrades, nftables, jq, curl, linux-image-extra-virtual]
package_reboot_if_required: true
write_files:
  # The i6300esb watchdog (the domain's <watchdog action='reset'>), driven by PID 1: a hung kernel or PID 1 stops
  # petting it and the VM is reset 30 s later. A shutdown that hangs is reset after 10 minutes.
  - path: /etc/modules-load.d/fff-watchdog.conf
    content: |
      i6300esb
  - path: /etc/systemd/system.conf.d/60-fff-watchdog.conf
    content: |
      [Manager]
      RuntimeWatchdogSec=30s
      RebootWatchdogSec=10min
  # Ubuntu blacklists watchdog drivers, and systemd-modules-load honours the blacklist, so modules-load.d alone left
  # i6300esb unloaded on every boot after the first (measured in CI). An explicit modprobe loads it; then PID 1 is
  # re-executed if it started before the device existed.
  - path: /etc/systemd/system/fff-watchdog-arm.service
    content: |
      [Unit]
      Description=fff-vm: make sure PID 1 drives the watchdog device
      After=systemd-modules-load.service
      [Service]
      Type=oneshot
      ExecStart=/bin/sh -c 'modprobe i6300esb; for i in \$(seq 20); do [ -e /dev/watchdog0 ] && break; sleep 1; done; [ "\$(cat /sys/class/watchdog/watchdog0/state 2>/dev/null)" = active ] || systemctl daemon-reexec; sleep 2; echo "watchdog0: \$(cat /sys/class/watchdog/watchdog0/state 2>/dev/null || echo missing)"'
      [Install]
      WantedBy=multi-user.target
  # Security updates every day; the host reboots the VM afterwards (fff-vm nightly at $NIGHTLY_TIME $NIGHTLY_TZ).
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
  - path: /etc/apt/apt.conf.d/52fff-unattended-upgrades
    content: |
      // fff-vm: the host's nightly cycle reboots the VM after the upgrades; never in the middle of the day.
      Unattended-Upgrade::Automatic-Reboot "false";
      Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
      Unattended-Upgrade::Remove-Unused-Dependencies "true";
  - path: /etc/systemd/system/apt-daily.timer.d/60-fff.conf
    content: |
      [Timer]
      OnCalendar=
      OnCalendar=*-*-* $update_at:00 $NIGHTLY_TZ
      RandomizedDelaySec=10m
  - path: /etc/systemd/system/apt-daily-upgrade.timer.d/60-fff.conf
    content: |
      [Timer]
      OnCalendar=
      OnCalendar=*-*-* $upgrade_at:00 $NIGHTLY_TZ
      RandomizedDelaySec=10m
  - path: /etc/fff-vm-guest.env
    content: |
      # From the host's install.sh: what the guest scripts (deploy/vm/guest) need to know about the host side.
      FFF_HOST_IP=$NET_HOST_IP
      FFF_VM_IP=$NET_VM_IP
      FFF_PORTAL_PORT=$PORTAL_PORT
      FFF_ADMIN_USER=$VM_ADMIN_USER
runcmd:
  - [modprobe, i6300esb]
  - [systemctl, daemon-reload]
  - [systemctl, start, qemu-guest-agent]
  - [systemctl, enable, --now, fff-watchdog-arm.service]
  - [systemctl, restart, apt-daily.timer, apt-daily-upgrade.timer]
final_message: "fff-vm: cloud-init finished after \$UPTIME s"
EOF
)
seed_iso="$VM_IMAGE_DIR/seed.iso"
if [ -n "$c1$c2$c3" ] || [ ! -f "$seed_iso" ]; then
  run_cmd cloud-localds --network-config="$seed/network-config" "$seed_iso" "$seed/user-data" "$seed/meta-data"
  run_cmd chmod 0600 "$seed_iso"
  if dom_exists && [ "$DRY_RUN" != 1 ]; then warn "the seed changed; cloud-init reads it only at the first boot of $instance_id, so a running VM keeps its first settings"; fi
fi
if [ "$VM_DISK_MODE" = zvol ]; then
  disk_xml="<disk type='block' device='disk'><driver name='qemu' type='raw' cache='none' io='native' discard='unmap'/><source dev='$disk'/><target dev='vda' bus='virtio'/></disk>"
else
  disk_xml="<disk type='file' device='disk'><driver name='qemu' type='qcow2' discard='unmap'/><source file='$disk'/><target dev='vda' bus='virtio'/></disk>"
fi
dom_changed=$(write_file "$FFF_VM_ETC/domain.xml" 0600 <<EOF
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
)
if ! dom_exists || [ -n "$dom_changed" ]; then
  run_cmd virsh --connect qemu:///system define "$FFF_VM_ETC/domain.xml"
  dom_exists || manifest_set domain_created "$VM_NAME"
  [ "$DRY_RUN" = 1 ] || manifest_set domain_created "$VM_NAME"
  if [ "$(dom_state)" = running ]; then warn "the domain's definition changed; it applies at the next cold start (fff-vm nightly, or virsh shutdown + start)"; fi
fi
run_cmd virsh --connect qemu:///system autostart "$VM_NAME"

# ---------------------------------------------------------------- 10. runtime: fff-vm, hang detection, nightly, events
log "10/10 fff-vm, hang detection, nightly reboot and alerts"
run_cmd install -d -m 0755 /usr/local/lib/fff-vm
for f in lib.sh fff-vm.conf.example; do write_file "/usr/local/lib/fff-vm/$f" 0644 <"$here/$f" >/dev/null; done
write_file /usr/local/sbin/fff-vm 0755 <"$here/fff-vm" >/dev/null
[ -f "$NTFY_URL_FILE" ] || warn "no $NTFY_URL_FILE: alerts are logged only. Put the ntfy URL with FF Factory's outside-watch topic there (one line, chmod 600)"
changed=""
for u in fff-vm-watch.service fff-vm-nightly.service fff-vm-events.service; do
  changed+=$(write_file "/etc/systemd/system/$u" 0644 <"$here/units/$u")
done
changed+=$(write_file /etc/systemd/system/fff-vm-watch.timer 0644 <<EOF
[Unit]
Description=fff-vm: is the FF Factory portal VM alive (every ${WATCH_INTERVAL_SEC}s)
[Timer]
OnBootSec=3min
OnUnitActiveSec=${WATCH_INTERVAL_SEC}s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
)
changed+=$(write_file /etc/systemd/system/fff-vm-nightly.timer 0644 <<EOF
[Unit]
Description=fff-vm: nightly drain, cold restart and snapshot of the FF Factory portal VM ($NIGHTLY_MODE)
[Timer]
OnCalendar=*-*-* $NIGHTLY_TIME:00 $NIGHTLY_TZ
Persistent=false
[Install]
WantedBy=timers.target
EOF
)
[ -z "$changed" ] || run_cmd systemctl daemon-reload
run_cmd systemctl enable fff-vm-watch.timer fff-vm-events.service
if [ "$NIGHTLY_MODE" = off ]; then run_cmd systemctl disable --now fff-vm-nightly.timer; else run_cmd systemctl enable fff-vm-nightly.timer; fi

if [ "$START" = 1 ]; then
  [ "$(dom_state)" = running ] || run_cmd virsh --connect qemu:///system start "$VM_NAME"
  run_cmd systemctl start fff-vm-watch.timer fff-vm-events.service
  [ "$NIGHTLY_MODE" = off ] || run_cmd systemctl start fff-vm-nightly.timer
  [ -z "$changed" ] || run_cmd systemctl try-restart fff-vm-events.service
fi
if [ "$WAIT" = 1 ] && [ "$DRY_RUN" != 1 ] && [ "$START" = 1 ]; then
  log "waiting for the guest agent (first boot: cloud-init upgrades, installs it and may reboot once; minutes)"
  for _ in $(seq 240); do guest_agent '{"execute":"guest-ping"}' >/dev/null && break; sleep 5; done
  guest_agent '{"execute":"guest-ping"}' >/dev/null || die "the guest agent did not answer within 20 minutes; look at /var/log/libvirt/qemu/$VM_NAME-serial.log"
  log "the guest agent answers"
fi

log "done. Next: sudo fff-vm status; sudo fff-vm ssh, then inside the VM: git clone https://github.com/Final-Factory/ff-factory.git && sudo ff-factory/deploy/vm/guest/install.sh (docs/portal-on-ffbox-host.md, 'Installing')"
[ "$DRY_RUN" != 1 ] || log "DRY RUN finished: nothing was changed"
