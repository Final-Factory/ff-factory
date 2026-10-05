#!/usr/bin/env bash
# commands for the guest are single-quoted on purpose: they expand there
# shellcheck disable=SC2016
# End-to-end test of the portal VM's host and guest scripts, on a THROWAWAY Ubuntu machine with KVM (CI's
# ubuntu-24.04 and ubuntu-26.04 runners). Never on the FFBox host or any machine that matters: it installs libvirt, creates and
# destroys a VM, loads an nftables table and resets the VM on purpose.
#
#   sudo deploy/vm/test/ci-vm-e2e.sh qcow2|zvol      (from the repository root, as root)
#
# What it proves, in order: the host install (twice: idempotent), the isolation (who reaches whom), the watchdog
# armed in the guest, the guest install and the portal's health, an update (build beside, drain, switch, verify), an
# automatic rollback of a broken update, the health restart of a hung server, the nightly drain + cold restart +
# snapshot, the hang detection's reset, the watchdog device's reset, and the uninstall.
set -o errexit -o nounset -o pipefail
MODE=${1:?qcow2 or zvol}
cd "$(dirname "$0")/../../.."
ROOT=$PWD
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
[ -n "${CI:-}" ] || [ "${FFF_E2E_I_AM_A_THROWAWAY:-}" = yes ] || { echo "refusing outside CI (set FFF_E2E_I_AM_A_THROWAWAY=yes on a throwaway machine)"; exit 1; }

step() { printf '\n==== %s %s\n' "$(date -u +%T)" "$*"; }
fail() { echo "FAIL: $*"; exit 1; }
# matches ARGS...: grep that reads all of its input. "grep -q" stops at the first match, and the writer of a pipe into it
# then dies of SIGPIPE, which pipefail turns into a failure (nft 1.1 on Ubuntu 26.04 hit it).
matches() { grep "$@" >/dev/null; }
VM=fff-portal
IP=10.213.41.10
HOSTIP=10.213.41.1
g() { /usr/local/sbin/fff-vm ssh "$@"; }
health() { curl -fsS -m 10 "http://$IP:8790/api/health"; }
wait_for() { # SECONDS DESCRIPTION CMD...
  local secs=$1 what=$2 t0
  shift 2
  t0=$(date +%s)
  until "$@" >/dev/null 2>&1; do
    [ $(($(date +%s) - t0)) -lt "$secs" ] || fail "$what: not within $secs s"
    sleep 5
  done
  echo "ok: $what ($(($(date +%s) - t0)) s)"
}
boot_id() { g cat /proc/sys/kernel/random/boot_id; }
sha_of() { health | jq -r .sha; }

step "host dry run before anything is installed"
mkdir -p /etc/fff-vm
cat >/etc/fff-vm/fff-vm.conf <<EOF
VM_DISK_MODE=$MODE
VM_ZVOL_PARENT=fffci/fff-vm
# The sizes are the defaults (D12: 2 vCPUs, 8 GiB), so CI boots the size the FFBox host runs; only the disk is small.
VM_DISK_GB=16
WATCH_INTERVAL_SEC=20
WATCH_FAILS_BEFORE_RESET=2
WATCH_BOOT_GRACE_SEC=90
NIGHTLY_MODE=always
SNAPSHOTS_KEEP=2
EOF
if [ "$MODE" = zvol ]; then
  apt-get install -y -q zfsutils-linux >/dev/null
  modprobe zfs
  truncate -s 40G /var/tmp/fffci.img
  zpool create -f fffci /var/tmp/fffci.img
fi
deploy/vm/host/install.sh --dry-run
if [ -e /var/lib/fff-vm/manifest ] || [ -e /usr/local/sbin/fff-vm ] || nft list table inet fff_vm >/dev/null 2>&1; then
  fail "the dry run changed something"
fi
echo "ok: the dry run changed nothing"

step "host install"
deploy/vm/host/install.sh --wait
/usr/local/sbin/fff-vm status
nft list table inet fff_vm | matches 'fff-vm: FF Factory portal VM' || fail "firewall table"
! pgrep -af dnsmasq | matches fff-isolated || fail "a dnsmasq serves the VM's network"
default_before=$(virsh net-info default 2>/dev/null | awk '/^Autostart:/ {print $2}' || true)
echo "MEASURE manifest: $(tr '\n' ' ' </var/lib/fff-vm/manifest)"
# shellcheck disable=SC1091
. /etc/os-release
echo "MEASURE host: $PRETTY_NAME, kernel $(uname -r); $(virsh version --daemon 2>/dev/null | grep -E 'library|hypervisor' | tr -s ' ' | tr '\n' ';'); $(nft --version); AppArmor $(dpkg-query -W -f='${Version}' apparmor 2>/dev/null)"
qpid=$(cat /run/libvirt/qemu/$VM.pid)
echo "MEASURE qemu process: user $(ps -o user= -p "$qpid"), AppArmor $(cat "/proc/$qpid/attr/current" 2>/dev/null || echo none)"
echo "libvirt default network autostart after install: ${default_before:-none}"

step "host install again: idempotent, the VM keeps running"
pid1=$(cat /run/libvirt/qemu/$VM.pid)
deploy/vm/host/install.sh 2>&1 | tee /tmp/second-install.log
[ "$(cat /run/libvirt/qemu/$VM.pid)" = "$pid1" ] || fail "the second install restarted the VM"

step "first boot: cloud-init, the watchdog"
wait_for 900 "ssh as the admin user" g true
# 0 done, 2 done with recoverable warnings, 1 failed.
wait_for 900 "cloud-init done" g 'cloud-init status --wait >/dev/null; test $? -ne 1'
g cloud-init status --long || true
wait_for 300 "watchdog0 armed by PID 1" g 'test "$(cat /sys/class/watchdog/watchdog0/state)" = active'
g 'cat /sys/class/watchdog/watchdog0/identity /sys/class/watchdog/watchdog0/timeout'

step "isolation"
g 'curl -fsS -m 20 -o /dev/null https://github.com' || fail "the VM cannot reach the internet"
echo "ok: the VM reaches the internet"
g "timeout 5 bash -c '</dev/tcp/$HOSTIP/22'" && fail "the VM reached the host's sshd on its bridge address"
echo "ok: the VM does not reach the host's sshd ($HOSTIP:22)"
lan=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')
g "timeout 5 bash -c '</dev/tcp/$lan/22'" && fail "the VM reached the host's LAN address $lan:22"
echo "ok: the VM does not reach the host's LAN address ($lan:22)"
gw=$(ip -4 route show default | awk '{print $3; exit}')
g "timeout 5 bash -c '</dev/tcp/$gw/53' || timeout 5 bash -c '</dev/tcp/$gw/80'" && fail "the VM reached the LAN gateway $gw"
echo "ok: the VM does not reach the LAN gateway ($gw)"
runuser -u nobody -- timeout 5 bash -c "</dev/tcp/$IP/22" && fail "a non-root host account reached the VM"
echo "ok: a non-root account on the host does not reach the VM"
if command -v docker >/dev/null; then
  # FFBox's Docker is rootless: its containers' processes are FFBox's own uids on the host, never root. The runner's
  # Docker is rootful, so a non-root --user stands in for that; a bridged container is forwarded through the host.
  # busybox nc -w bounds the connect itself (a shell's /dev/tcp waited out the kernel's 2-minute connect timeout).
  docker run --rm --network host --user 1000:1000 busybox:stable nc -w 3 "$IP" 22 </dev/null &&
    fail "a non-root container on the host's network reached the VM"
  docker run --rm busybox:stable nc -w 3 "$IP" 22 </dev/null && fail "a bridged container reached the VM"
  echo "ok: containers (non-root on the host's network, and bridged) do not reach the VM"
fi
nft list table inet fff_vm | grep -E 'counter packets [1-9]' || true

step "guest install"
git -C "$ROOT" branch -f main HEAD
git -C "$ROOT" bundle create /tmp/ff.bundle HEAD main
g 'cat > /tmp/ff.bundle' </tmp/ff.bundle
g 'chmod 644 /tmp/ff.bundle && rm -rf /tmp/ff-factory && git clone -q -b main /tmp/ff.bundle /tmp/ff-factory'
g 'sudo /tmp/ff-factory/deploy/vm/guest/install.sh --dry-run'
t0=$(date +%s)
g 'sudo /tmp/ff-factory/deploy/vm/guest/install.sh --repo /tmp/ff.bundle'
echo "MEASURE guest install (packages, npm ci, web build, start) in a $(g nproc)-vCPU VM: $(($(date +%s) - t0)) s"
g 'printf "UPDATE_VERIFY_MIN=2\nBASE_REPO_URL=https://github.com/Final-Factory/ff-factory.git\nBASE_BRANCH=main\n" | sudo tee -a /etc/fff/fff.conf'
wait_for 120 "the portal answers the host" health
health
[ "$(sha_of)" = "$(git -C "$ROOT" rev-parse --short=7 HEAD)" ] || fail "the portal runs $(sha_of), not HEAD"
g 'sudo fffctl status'
sleep 60
g 'echo "MEASURE guest memory (MiB), portal idle with empty data:"; free -m; echo "MEASURE node server RSS (KiB): $(ps -o rss= -p $(systemctl show -p MainPID --value fff-portal))"; echo "MEASURE release on disk: $(sudo sh -c "du -sh /srv/fff/app/releases/*/" | head -n 1)"; echo "MEASURE npm cache: $(sudo du -sh /srv/fff/home/.npm | cut -f1)"; echo "MEASURE bare repo: $(sudo du -sh /srv/fff/app/repo.git | cut -f1)"; echo "MEASURE root filesystem:"; df -h /'
g 'sudo /tmp/ff-factory/deploy/vm/guest/install.sh --repo /tmp/ff.bundle' | tail -n 3
echo "ok: the guest install ran twice"
g 'sudo fffctl base-clone' && g 'sudo systemctl start fff-base-refresh.service && sudo journalctl -u fff-base-refresh -n 3 --no-pager'
g 'sudo nft list table inet fff_guest' >/dev/null || fail "the guest's firewall table"
# The subscription token's store (decision D4), with a dummy token: 0600, fff's, and never printed whole.
out=$(g 'printf "sk-ant-oat01-ci-dummy-WXYZ\n" >/tmp/k && sudo fffctl claude-token --file /tmp/k; rm -f /tmp/k')
echo "$out"
if printf '%s' "$out" | matches 'ci-dummy'; then fail "fffctl claude-token printed the token"; fi
[ "$(g 'sudo stat -c "%a %U" /srv/fff/secrets/claude-oauth-token')" = "600 fff" ] || fail "the token file is not 0600 fff"
echo "ok: the token is stored 0600, owned by fff, shown only as its last four characters"

step "update: build beside the running portal, drain, switch, verify"
before=$(sha_of)
git -C "$ROOT" -c user.name=ci -c user.email=ci@users.noreply.github.com commit -q --allow-empty -m "ci: an update to install"
git -C "$ROOT" branch -f main HEAD
git -C "$ROOT" bundle create /tmp/ff.bundle HEAD main
g 'cat > /tmp/ff.bundle.new && mv /tmp/ff.bundle.new /tmp/ff.bundle && chmod 644 /tmp/ff.bundle' </tmp/ff.bundle
want=$(git -C "$ROOT" rev-parse --short=7 HEAD)
g 'sudo fffctl update --drain-minutes 0'
t0=$(date +%s)
down=0
until [ "$(health 2>/dev/null | jq -r .sha 2>/dev/null)" = "$want" ]; do
  health >/dev/null 2>&1 || down=$((down + 2))
  [ $(($(date +%s) - t0)) -lt 900 ] || fail "the portal does not run $want after 900 s"
  sleep 2
done
echo "MEASURE update: $(($(date +%s) - t0)) s from fffctl update to the new version answering; health unanswered for about $down s of it"
g 'sudo cat /srv/fff/data/update.result.json' | jq -e --arg w "$want" '.ok == true and (.headAfter | startswith($w)) and (.headBefore | length) > 0' || fail "update.result.json does not record the switch to $want"
wait_for 300 "the update verified" g 'test ! -e /srv/fff/data/update.verifying.json'
echo "ok: $before -> $want"

step "a broken update is rolled back by itself"
good=$want
sed -i '1i throw new Error("ci: broken on purpose");' "$ROOT/server/index.ts"
git -C "$ROOT" -c user.name=ci -c user.email=ci@users.noreply.github.com commit -q -am "ci: a broken update"
git -C "$ROOT" branch -f main HEAD
git -C "$ROOT" bundle create /tmp/ff.bundle HEAD main
g 'cat > /tmp/ff.bundle.new && mv /tmp/ff.bundle.new /tmp/ff.bundle && chmod 644 /tmp/ff.bundle' </tmp/ff.bundle
g 'sudo fffctl update --drain-minutes 0'
# Expected within about 3 minutes (UPDATE_VERIFY_MIN=2, fff-health every 30 s); on a timeout, say why before failing.
t0=$(date +%s)
until g 'sudo cat /srv/fff/data/update.result.json' 2>/dev/null | jq -e '.ok == false and (.error | test("rolled back"))' >/dev/null 2>&1; do
  if [ $(($(date +%s) - t0)) -ge 480 ]; then
    g 'sudo fffctl status; sudo cat /srv/fff/data/update.result.json /srv/fff/data/update.verifying.json; sudo ls -la /srv/fff/app /srv/fff/data; sudo journalctl --no-pager -n 60 -u fff-update -u fff-health -u fff-portal' || true
    fail "no rollback within 480 s"
  fi
  sleep 5
done
echo "ok: rolled back to $good ($(($(date +%s) - t0)) s)"
wait_for 300 "the portal runs $good again" bash -c "[ \"\$(curl -fsS -m 10 http://$IP:8790/api/health | jq -r .sha)\" = $good ]"
g 'ls /srv/fff/data/orchestrator-inbox/ 2>/dev/null | tail -n 3; sudo sh -c "cat /srv/fff/data/orchestrator-inbox/*.txt 2>/dev/null | tail -n 5"' || true
git -C "$ROOT" reset -q --hard HEAD~1

step "a hung server is restarted by fff-health"
pid=$(g 'systemctl show -p MainPID --value fff-portal')
g "sudo kill -STOP $pid"
wait_for 600 "a new server process" bash -c "[ \"\$(/usr/local/sbin/fff-vm ssh 'systemctl show -p MainPID --value fff-portal')\" != $pid ]"
wait_for 300 "the portal answers again" health

step "prepare-shutdown holds the portal (ExecCondition), fffctl start brings it back"
g 'sudo fffctl prepare-shutdown --drain-minutes 0'
sleep 20
st=$(g 'systemctl is-active fff-portal' || true)
[ "$st" = inactive ] || fail "the held portal is '$st', not inactive (Restart=always started it again?)"
echo "MEASURE held portal: $st; $(g 'systemctl show -p Result -p NRestarts fff-portal | tr "\n" " "')"
g 'sudo fffctl start'
wait_for 120 "the portal answers after fffctl start" health

step "nightly: drain, cold restart, snapshot"
b1=$(boot_id)
pid1=$(cat /run/libvirt/qemu/$VM.pid)
/usr/local/sbin/fff-vm nightly --now
[ "$(cat /run/libvirt/qemu/$VM.pid)" != "$pid1" ] || fail "the nightly did not cold-start QEMU"
[ "$(boot_id)" != "$b1" ] || fail "the guest did not boot again"
/usr/local/sbin/fff-vm snapshots | matches '^fff-nightly-' || fail "no nightly snapshot"
wait_for 300 "the portal answers after the nightly" health
journalctl -u fff-vm-nightly --no-pager -n 0 >/dev/null 2>&1 || true
echo "ok: nightly ($(/usr/local/sbin/fff-vm snapshots | tr '\n' ' '))"

step "hang detection: neither the agent nor the portal answers -> reset"
b1=$(boot_id)
g 'sudo systemctl stop fff-health.timer fff-portal qemu-guest-agent' || true
wait_for 600 "the watch reset the VM" bash -c "[ \"\$(/usr/local/sbin/fff-vm ssh cat /proc/sys/kernel/random/boot_id 2>/dev/null)\" != '' ] && [ \"\$(/usr/local/sbin/fff-vm ssh cat /proc/sys/kernel/random/boot_id)\" != $b1 ]"
journalctl -u fff-vm-watch --no-pager | grep -m1 'resetting' || fail "no reset in the watch's log"
wait_for 300 "the portal answers after the reset" health

step "watchdog device: a guest that stops petting it is reset"
b1=$(boot_id)
wait_for 300 "watchdog0 armed again" g 'test "$(cat /sys/class/watchdog/watchdog0/state)" = active'
systemctl stop fff-vm-watch.timer
# PID 1 lets go of the device cleanly, then a process opens it and dies without the magic close: nobody pets it.
g 'printf "[Manager]\nRuntimeWatchdogSec=off\n" | sudo tee /etc/systemd/system.conf.d/99-ci.conf >/dev/null && sudo systemctl daemon-reexec'
g "sudo sh -c 'exec 3>/dev/watchdog; echo x >&3; kill -9 \$\$'" || true
wait_for 300 "the watchdog reset the VM" bash -c "[ \"\$(/usr/local/sbin/fff-vm ssh cat /proc/sys/kernel/random/boot_id 2>/dev/null)\" != '' ] && [ \"\$(/usr/local/sbin/fff-vm ssh cat /proc/sys/kernel/random/boot_id)\" != $b1 ]"
journalctl -u fff-vm-events --no-pager | grep -m1 'watchdog fired' || fail "fff-vm events did not see the watchdog"
g 'sudo rm -f /etc/systemd/system.conf.d/99-ci.conf'
systemctl start fff-vm-watch.timer

step "uninstall"
deploy/vm/host/uninstall.sh --dry-run
virsh dominfo $VM >/dev/null || fail "the uninstall dry run removed the VM"
deploy/vm/host/uninstall.sh --delete-disk
! virsh dominfo $VM >/dev/null 2>&1 || fail "the domain is still defined"
! virsh net-info fff-isolated >/dev/null 2>&1 || fail "the network is still defined"
! nft list table inet fff_vm >/dev/null 2>&1 || fail "the firewall table is still loaded"
if [ -e /usr/local/sbin/fff-vm ] || [ -e /etc/systemd/system/fff-vm-watch.timer ]; then fail "files left"; fi
echo "libvirt default network autostart after uninstall: $(virsh net-info default 2>/dev/null | awk '/^Autostart:/ {print $2}')"
echo
echo "ALL PASSED ($MODE)"
