#!/usr/bin/env bash
# commands for the guest are single-quoted on purpose: they expand there
# shellcheck disable=SC2016
# End-to-end test of the portal VM's host and guest scripts, on a THROWAWAY Ubuntu machine with KVM (CI's
# ubuntu-24.04 and ubuntu-26.04 runners). Never on the FFBox host or any machine that matters: it installs libvirt, creates and
# destroys a VM, loads an nftables table and resets the VM on purpose.
#
#   sudo deploy/vm/test/ci-vm-e2e.sh qcow2|zvol      (from the repository root, as root)
#
# What it proves, in order: a missing token stops the install before any change, the host install (twice: idempotent), the isolation (who reaches whom), the watchdog
# armed in the guest, the guest install and the portal's health, an update (build beside, drain, switch, verify), an
# automatic rollback of a broken update, the health restart of a hung server, the nightly drain + cold restart +
# snapshot, a size change in fff-vm.conf applied by the nightly and one it goes back from, the hang detection's reset,
# the watchdog device's reset, and the uninstall.
set -o errexit -o nounset -o pipefail
MODE=${1:?qcow2 or zvol}
# fast (the default: pull requests, main): the watch, health and update-verify timers short, so the scenarios that wait
# on them take seconds; set only here, in the test's own settings and drop-ins, never in the shipped defaults.
# production (nightly): the shipped defaults, as the FFBox host runs them (deploy/vm/host/fff-vm.conf.example,
# deploy/vm/guest/fff.conf.example, the units as installed).
TIMING=${CI_TIMING:-fast}
case "$TIMING" in fast | production) ;; *) echo "CI_TIMING is fast or production" >&2; exit 2 ;; esac
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
# The bundle's main must be HEAD. On a push to main the checkout IS main (git refuses to force-move the branch a worktree
# has checked out, which failed every main run from #108 to w505), and it is already HEAD.
main_at_head() { [ "$(git -C "$ROOT" branch --show-current)" = main ] || git -C "$ROOT" branch -f main HEAD; }
health() { curl -fsS -m 10 "http://$IP:8790/api/health"; }
wait_for() { # SECONDS DESCRIPTION CMD...
  local secs=$1 what=$2 t0 p0
  shift 2
  t0=$(date +%s)
  until p0=$(date +%s); "$@" >/dev/null 2>&1; do
    [ $(($(date +%s) - p0)) -lt 15 ] || echo "  $what: one check took $(($(date +%s) - p0)) s"
    [ $(($(date +%s) - t0)) -lt "$secs" ] || fail "$what: not within $secs s"
    sleep 5
  done
  echo "ok: $what ($(($(date +%s) - t0)) s)"
}
boot_id() { g cat /proc/sys/kernel/random/boot_id; }
# rebooted_since BOOT_ID: the guest answers with another boot id. Each look has 20 s: an ssh that is open when the VM
# is reset can hear nothing more and wait on TCP for minutes (hang detection took 382-988 s in 6 of 61 runs, against
# 99-120 s in the rest; w636).
rebooted_since() {
  local now
  now=$(timeout 20 /usr/local/sbin/fff-vm ssh cat /proc/sys/kernel/random/boot_id 2>/dev/null) && [ -n "$now" ] && [ "$now" != "$1" ]
}
sha_of() { health | jq -r .sha; }

step "host dry run before anything is installed"
mkdir -p /etc/fff-vm
# The answers install.sh would ask for (answers.sh), stored as a person's first run stores them; no Tailscale or GitHub
# in CI. The ntfy URL points nowhere, so CI's resets send no real alerts.
cat >/etc/fff-vm/fff-vm.conf <<EOF
VM_DISK_MODE=$MODE
VM_ZVOL_PARENT=fffci/fff-vm
VM_ZFS_MOUNTPOINT=/fffci/fff-vm
VM_TIMEZONE=America/Denver
PORTAL_OWNER_NAME=CI
GUEST_TAILSCALE=skip
GUEST_GITHUB=skip
GUEST_BACKUP_SSH_TARGET=
# The sizes are the defaults (D12: 2 vCPUs, 4 GiB), so CI boots the size the FFBox host runs; only the disk is small.
VM_DISK_GB=16
$(if [ "$TIMING" = fast ]; then printf 'WATCH_INTERVAL_SEC=10\nWATCH_FAILS_BEFORE_RESET=2\nWATCH_BOOT_GRACE_SEC=90\n'; fi)
NIGHTLY_MODE=always
SNAPSHOTS_KEEP=2
EOF
if [ "$MODE" = zvol ]; then
  apt-get install -y -q zfsutils-linux >/dev/null
  modprobe zfs
  truncate -s 40G /var/tmp/fffci.img
  zpool create -f fffci /var/tmp/fffci.img
fi
ssh-keygen -q -t ed25519 -N '' -C ci-admin -f /root/ci-admin
cp /root/ci-admin.pub /etc/fff-vm/admin_authorized_keys
echo 'https://127.0.0.1:9/fff-ci' >/etc/fff-vm/ntfy-url
chmod 600 /etc/fff-vm/ntfy-url
deploy/vm/host/install.sh --dry-run
if [ -e /var/lib/fff-vm/manifest ] || [ -e /usr/local/sbin/fff-vm ] || nft list table inet fff_vm >/dev/null 2>&1; then
  fail "the dry run changed something"
fi
echo "ok: the dry run changed nothing"

step "a missing token stops the install before it changes anything"
conf_before=$(sha256sum /etc/fff-vm/fff-vm.conf)
rc=0
deploy/vm/host/install.sh --yes >/tmp/no-token.log 2>&1 || rc=$?
cat /tmp/no-token.log
[ "$rc" = 2 ] || fail "a run without the Claude token exited $rc, not 2"
matches 'secrets/claude-token' /tmp/no-token.log || fail "the refusal does not name the missing Claude token"
if [ -e /var/lib/fff-vm/manifest ] || [ -e /usr/local/sbin/fff-vm ] || nft list table inet fff_vm >/dev/null 2>&1 ||
  dpkg -l libvirt-daemon-system 2>/dev/null | grep '^ii' >/dev/null || [ "$(sha256sum /etc/fff-vm/fff-vm.conf)" != "$conf_before" ]; then
  fail "the refused run changed something"
fi
echo "ok: refused before any change, naming what is missing"
# The stored answers a person's first run leaves (answers.sh): root's, 0600 in a 0700 folder.
install -d -m 0700 /etc/fff-vm/secrets
printf 'sk-ant-oat01-ci-dummy-0123456789abcdef-WXYZ\n' | install -m 0600 /dev/stdin /etc/fff-vm/secrets/claude-token

step "host install"
deploy/vm/host/install.sh --host-only --wait
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
# As on Loth2400 (w497), where --no-install-recommends left it uncreated: the install must make it, or the VM's next
# start (the nightly cold restart below) fails on "Failed to create file '/var/lib/libvirt/dnsmasq/virbr-fff.macs.new'".
rm -rf /var/lib/libvirt/dnsmasq
deploy/vm/host/install.sh --host-only 2>&1 | tee /tmp/second-install.log
[ "$(cat /run/libvirt/qemu/$VM.pid)" = "$pid1" ] || fail "the second install restarted the VM"
[ -d /var/lib/libvirt/dnsmasq ] || fail "the install did not create /var/lib/libvirt/dnsmasq"

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

step "guest install, from the host (install.sh --guest-only: the stored answers, no questions)"
main_at_head
git -C "$ROOT" bundle create /tmp/ff.bundle HEAD main
t0=$(date +%s)
deploy/vm/host/install.sh --guest-only --yes --guest-repo-bundle /tmp/ff.bundle 2>&1 | tee /tmp/guest-install.log
echo "MEASURE guest install (packages, npm ci, web build, start, settings) in a $(g nproc)-vCPU VM: $(($(date +%s) - t0)) s"
if matches -e 'ci-dummy' -e '0123456789abcdef' /tmp/guest-install.log; then fail "the install printed the Claude token"; fi
[ "$(g 'sudo stat -c "%a %U" /srv/fff/secrets/claude-oauth-token')" = "600 fff" ] || fail "the stored token is not 0600 fff"
g 'test ! -e /run/fff-install/claude-token' || fail "the token's hand-over file was left in the guest"
g 'sudo jq -e ".ownerName == \"CI\" and .claudeAccounts.orchestrator == \"tokenfile\" and .claudeAccounts.dispatcher == \"tokenfile\" and .claudeTokenFile == \"/srv/fff/secrets/claude-oauth-token\"" /srv/fff/config/config.json' >/dev/null ||
  fail "config.json was not set: $(g 'sudo jq -c "{ownerName, claudeAccounts, claudeTokenFile}" /srv/fff/config/config.json')"
matches 'Tailscale: skipped' /tmp/guest-install.log || fail "the end of the install does not list the skipped Tailscale join"
echo "ok: the guest is set up from the host, the token stored and never printed, config.json set"
# The machines' ssh (w537): the guest install wrote the portal account's aliases and pinned host keys (machines.ssh).
# No machine answers here: each is pinned anyway, and nothing is accepted on first use.
out=$(g 'sudo -H -u fff /usr/local/lib/fff/fff-machine-ssh --check' 2>&1 || true)
echo "$out"
for m in m3 m5 Loth2800 beast; do
  printf '%s\n' "$out" | matches "^$m: alias ok; known_hosts: pinned; tailnet: no answer" || fail "fff-machine-ssh: $m is not set up after the guest install"
done
[ "$(g 'sudo stat -c "%a %U" /srv/fff/home/.ssh/config /srv/fff/home/.ssh/known_hosts' | sort -u)" = "600 fff" ] || fail "the portal's ssh config or known_hosts is not 0600 fff"
if printf '%s' "$out" | matches 'PRIVATE KEY'; then fail "fff-machine-ssh printed a private key"; fi
echo "ok: the portal's ssh aliases and pinned host keys for the machines"
# An installed machine's host keys are pinned in the portal's own ~/.ssh/known_hosts2 (w568, server/machineSsh.ts): the
# guest's ssh must read it by default, beside known_hosts.
ukh=$(g 'sudo -H -u fff ssh -G no-such-machine.invalid' | awk '$1 == "userknownhostsfile"')
echo "MEASURE the portal account's ssh known_hosts files: $ukh"
printf '%s
' "$ukh" | matches '/srv/fff/home/.ssh/known_hosts2' || fail "the guest's ssh does not read ~/.ssh/known_hosts2"
[ "$MODE" != zvol ] || [ "$(zfs get -H -o value mountpoint fffci/fff-vm)" = /fffci/fff-vm ] || fail "the dataset's mountpoint is not the stored answer"
g 'printf "BASE_REPO_URL=https://github.com/Final-Factory/ff-factory.git\nBASE_BRANCH=main\n" | sudo tee -a /etc/fff/fff.conf'
if [ "$TIMING" = fast ]; then
  # A new release has 45 s to answer; a hung server is restarted after 2 failed checks 10 s apart, 20 s after its start,
  # and killed 15 s after SIGTERM. The same code paths as the defaults (5 min, 4 x 30 s, 120 s, 75 s), sooner.
  g 'printf "UPDATE_VERIFY_SEC=45\nHEALTH_FAILS_BEFORE_RESTART=2\nHEALTH_START_GRACE_SEC=20\n" | sudo tee -a /etc/fff/fff.conf'
  g 'sudo mkdir -p /etc/systemd/system/fff-health.timer.d /etc/systemd/system/fff-portal.service.d &&
     printf "[Timer]\nOnUnitActiveSec=10s\n" | sudo tee /etc/systemd/system/fff-health.timer.d/ci-fast.conf >/dev/null &&
     printf "[Service]\nTimeoutStopSec=15\n" | sudo tee /etc/systemd/system/fff-portal.service.d/ci-fast.conf >/dev/null &&
     sudo systemctl daemon-reload && sudo systemctl restart fff-health.timer'
fi
wait_for 120 "the portal answers the host" health
health
[ "$(sha_of)" = "$(git -C "$ROOT" rev-parse --short=7 HEAD)" ] || fail "the portal runs $(sha_of), not HEAD"
g 'sudo fffctl status'
# Production timing only: the idle memory needs a minute to settle; the fast run measures it at once.
[ "$TIMING" != production ] || sleep 60
g 'echo "MEASURE guest memory (MiB), portal idle with empty data:"; free -m; echo "MEASURE node server RSS (KiB): $(ps -o rss= -p $(systemctl show -p MainPID --value fff-portal))"; echo "MEASURE release on disk: $(sudo sh -c "du -sh /srv/fff/app/releases/*/" | head -n 1)"; echo "MEASURE npm cache: $(sudo du -sh /srv/fff/home/.npm | cut -f1)"; echo "MEASURE bare repo: $(sudo du -sh /srv/fff/app/repo.git | cut -f1)"; echo "MEASURE root filesystem:"; df -h /'
deploy/vm/host/install.sh --guest-only --yes --guest-repo-bundle /tmp/ff.bundle 2>&1 | tail -n 12
echo "ok: the guest install ran twice"
g 'sudo fffctl base-clone' && g 'sudo systemctl start fff-base-refresh.service && sudo journalctl -u fff-base-refresh -n 3 --no-pager'
g 'sudo nft list table inet fff_guest' >/dev/null || fail "the guest's firewall table"
# The subscription token's store (decision D4), with a dummy token: 0600, fff's, and never printed whole.
out=$(g 'printf "sk-ant-oat01-ci-dummy-WXYZ\n" >/tmp/k && sudo fffctl claude-token --file /tmp/k; rm -f /tmp/k')
echo "$out"
if printf '%s' "$out" | matches 'ci-dummy'; then fail "fffctl claude-token printed the token"; fi
[ "$(g 'sudo stat -c "%a %U" /srv/fff/secrets/claude-oauth-token')" = "600 fff" ] || fail "the token file is not 0600 fff"
echo "ok: the token is stored 0600, owned by fff, shown only as its last four characters"
# The token vault (w512, docs/vault.md): the key is root's alone and reaches the portal as a systemd credential; a value
# added with fffctl is never printed, sealed on disk, and the vault file stays the portal user's.
[ "$(g 'sudo stat -c "%a %U" /etc/fff/vault.key')" = "600 root" ] || fail "the vault key is not 0600 root"
if g 'sudo -u fff cat /etc/fff/vault.key' >/dev/null 2>&1; then fail "the fff user can read the vault key file"; fi
g 'sudo test -s /run/credentials/fff-portal.service/fff-vault-key' || fail "the portal did not get the vault key as a credential"
out=$(g 'printf "ci-vault-secret-QRST\n" >/tmp/v && sudo fffctl vault add --name ci-env --kind env --env CI_E2E_TOKEN --share anyone --file /tmp/v; rm -f /tmp/v')
echo "$out"
if printf '%s' "$out" | matches 'ci-vault-secret'; then fail "fffctl vault add printed the value"; fi
g 'sudo fffctl vault list' | matches 'key: loaded' || fail "fffctl vault list: the key is not loaded"
if g 'sudo grep -c ci-vault-secret /srv/fff/data/vault.json' >/dev/null 2>&1; then fail "the vault file holds the value in plain text"; fi
[ "$(g 'sudo stat -c "%a %U" /srv/fff/data/vault.json')" = "600 fff" ] || fail "vault.json is not 0600 fff"
out=$(g 'sudo fffctl machine-credential issue ci-m1 --out /tmp/cred && sudo stat -c "%a %U" /tmp/cred && sudo fffctl machine-credential revoke ci-m1; sudo rm -f /tmp/cred')
echo "$out"
printf '%s' "$out" | matches '^600 root$' || fail "the issued machine credential's file is not 0600 root"
if printf '%s' "$out" | matches 'ffm_ci-m1_'; then fail "fffctl machine-credential printed the credential"; fi
g 'sudo fffctl vault remove ci-env' >/dev/null
echo "ok: the vault key is root's and loaded by the portal; values and credentials never printed"
# Whose tokens (w512, docs/vault.md): a person's tokens kept on the host go into the vault with fff-vm vault-sync, never
# printed; a classic GitHub token is refused; a second sync changes nothing; a removed file removes its entry; the key's
# spare copy on the host matches the VM's key.
# No head at the end of the pipe: under pipefail its early exit would SIGPIPE the writers.
rnd() { local s; s=$(head -c 96 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }
ct="sk-ant-oat01-$(rnd 44)"
gt="github_pat_$(rnd 40)"
install -d -m 0700 /etc/fff-vm/secrets/people/ci /etc/fff-vm/secrets/people/ci2
printf '%s\n' "$ct" | install -m 0600 /dev/stdin /etc/fff-vm/secrets/people/ci/claude-token
printf '%s\n' "$gt" | install -m 0600 /dev/stdin /etc/fff-vm/secrets/people/ci/github-token
printf 'ghp_%s\n' "$(rnd 36)" | install -m 0600 /dev/stdin /etc/fff-vm/secrets/people/ci2/github-token
out=$(/usr/local/sbin/fff-vm vault-sync 2>&1) || true
echo "$out"
for v in "$ct" "$gt"; do if printf '%s' "$out" | matches -F "${v:13:24}"; then fail "fff-vm vault-sync printed a token"; fi; done
printf '%s' "$out" | matches 'not one fine-grained GitHub token' || fail "a classic GitHub token was not refused"
list=$(g 'sudo fffctl vault list')
printf '%s' "$list" | matches -F "${ct: -4}" || fail "host-ci-claude is not in the vault: $list"
printf '%s' "$list" | matches '^host-ci-github ' || fail "host-ci-github is not in the vault: $list"
if printf '%s' "$list" | matches '^host-ci2-'; then fail "the refused token went in"; fi
[ "$(stat -c '%a %U' /etc/fff-vm/secrets/vault.key)" = "600 root" ] || fail "the key's spare copy is not 0600 root"
# The file is named to sha256sum under sudo: a "<" redirect would be opened by the admin's own shell, which cannot read it.
[ "$(sha256sum /etc/fff-vm/secrets/vault.key | cut -c1-64)" = "$(g 'sudo sha256sum /etc/fff/vault.key' | cut -c1-64)" ] || fail "the key's spare copy differs from the VM's key"
# Captured first: the sync exits 1 (ci2's classic token is still refused), which pipefail would carry through a pipe.
out=$(/usr/local/sbin/fff-vm vault-sync 2>&1) || true
printf '%s' "$out" | matches 'unchanged host-ci-claude' || fail "a second sync was not a no-op: $out"
printf '%s' "$out" | matches 'unchanged host-ci-github' || fail "a second sync was not a no-op: $out"
rm -rf /etc/fff-vm/secrets/people/ci /etc/fff-vm/secrets/people/ci2
/usr/local/sbin/fff-vm vault-sync >/dev/null 2>&1 || true
if g 'sudo fffctl vault list --names' | matches '^host-ci-'; then fail "a removed person's entries stayed in the vault"; fi
echo "ok: fff-vm vault-sync: per-person tokens in, never printed, a classic GitHub token refused, removals follow, the key copied"
# fffctl migrate (w499) in a real guest: the wrapper, node in the release, ssh as fff with the portal's key. No BEAST here,
# so it cannot connect: it says so, prints the line that authorizes the key, and changes nothing. (The modes themselves
# run end to end against a synthetic BEAST in the unit tests: scripts/fff-migrate.test.ts.)
set +e
out=$(g 'sudo fffctl migrate --key --ssh rydin@beast.invalid' 2>&1)
rc=$?
set -e
echo "$out"
[ "$rc" = 2 ] || fail "fffctl migrate --key without a BEAST: exit $rc, not 2"
printf '%s' "$out" | matches -F 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 ' || fail "fffctl migrate --key printed no authorized_keys line"
printf '%s' "$out" | matches 'cannot reach BEAST as rydin@beast.invalid' || fail "fffctl migrate --key did not say it could not connect"
if printf '%s' "$out" | matches 'ci-dummy'; then fail "fffctl migrate printed the token"; fi
g 'test ! -e /srv/fff/migrate/dry-run.json' || fail "fffctl migrate --key changed something"
echo "ok: fffctl migrate runs in the guest: it says when BEAST cannot be reached, with the key line to authorize"

step "the orchestration worker (w597): its account, its capped scratch, its socket, its two sudo rights, its launcher"
g 'id fff-ops' | matches 'fff-ops' || fail "no fff-ops account"
g 'sudo passwd -S fff-ops' | matches ' L ' || fail "fff-ops has a usable password"
mnt=$(g 'findmnt -n -o FSTYPE,OPTIONS /srv/fff-ops' || true)
printf '%s' "$mnt" | matches '^ext4 .*nosuid.*nodev.*noexec' || fail "/srv/fff-ops is not its nosuid,nodev,noexec ext4 scratch: $mnt"
size=$(g 'df -m --output=size /srv/fff-ops | tail -n 1' | tr -d ' ' || true)
case "$size" in '' | *[!0-9]*) fail "no size for /srv/fff-ops: '$size'" ;; esac
if [ "$size" -le 1500 ] || [ "$size" -gt 2048 ]; then fail "the scratch is $size MB, not about OPS_DISK_MB=2048"; fi
# Full is full: a file bigger than the cap stops at the cap, and the VM's own disk is untouched.
out=$(g 'sudo -u fff-ops dd if=/dev/zero of=/srv/fff-ops/scratch/fill bs=1M count=3000 2>&1; sudo rm -f /srv/fff-ops/scratch/fill' || true)
printf '%s' "$out" | matches 'No space left on device' || fail "a 3 GB write into the scratch did not hit its cap: $out"
[ "$(g 'sudo stat -c "%a %U %G" /run/fff-ops/claude.sock')" = "600 fff fff" ] || fail "the socket is not 0600 fff"
g 'systemctl is-active fff-ops.socket' | matches -x active || fail "fff-ops.socket is not listening"
for f in /srv/fff/config/config.json /srv/fff/home/.ssh/id_ed25519 /etc/fff/vault.key; do
  if g "sudo -u fff-ops cat $f" >/dev/null 2>&1; then fail "fff-ops can read $f"; fi
done
# sudo: fff-ops-priv as root and fff-ops-ssh as fff, nothing else.
g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl status' | matches '^portal: active' || fail "the worker's fffctl status does not work"
g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl logs 5' >/dev/null || fail "the worker's fffctl logs does not work"
for bad in 'sudo -n /usr/local/sbin/fffctl restart' 'sudo -n /usr/local/lib/fff/fff-ops-priv update' 'sudo -n /usr/local/lib/fff/fff-ops-priv vault list' \
  'sudo -n -u fff /bin/cat /srv/fff/config/config.json' 'sudo -n -u fff /usr/local/lib/fff/fff-ops-ssh -oProxyCommand=id x' 'sudo -n apt-get install -y htop'; do
  if g "sudo -u fff-ops $bad" >/dev/null 2>&1; then fail "fff-ops may run: $bad"; fi
done
# A credential for a machine that does not answer ssh is not issued at all (it would only cut that machine off).
out=$(g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl credential issue ci-m2 --to nosuchhost.invalid 2>&1' || true)
printf '%s' "$out" | matches 'does not answer ssh' || fail "credential issue to an unreachable machine: $out"
if g 'sudo fffctl machine-credential list' | matches -x 'ci-m2'; then fail "a credential was issued for a machine that cannot get it"; fi
# The launcher, through the socket, as the portal's account: the header, OK, then Claude Code itself (its --version needs
# no credential to answer, but the launcher wants one: a dummy).
# Its Claude credential lives only in claude's memory: Yama keeps the commands it runs from reading their parent's.
[ "$(g 'cat /proc/sys/kernel/yama/ptrace_scope')" -ge 1 ] || fail "Yama's ptrace_scope is 0: a worker's command could read claude's memory"
g 'test -x /usr/local/lib/fff/ops/claude && test -s /usr/local/lib/fff/ops/claude.version' || fail "fff-ops-sync did not give the worker its Claude Code"
cat >/tmp/fff-ops-sock.js <<'EOF'
const net = require('node:net');
const fs = require('node:fs');
const v = fs.readFileSync('/usr/local/lib/fff/ops/claude.version', 'utf8').trim();
const s = net.createConnection({ path: '/run/fff-ops/claude.sock', allowHalfOpen: true });
s.write(JSON.stringify({ v: 1, sdkVersion: process.argv[2] || v, args: ['--version'], env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ci-dummy-not-a-token' } }) + '\n');
s.end();
let out = '';
s.on('data', (d) => (out += d));
s.on('close', () => process.stdout.write(out, () => process.exit(0)));
s.on('error', (e) => process.stdout.write('ERROR ' + e.message, () => process.exit(0)));
setTimeout(() => process.stdout.write(out + ' TIMEOUT', () => process.exit(0)), 30000).unref();
EOF
b64=$(base64 -w0 /tmp/fff-ops-sock.js)
out=$(g "echo $b64 | base64 -d >/tmp/fff-ops-sock.js && sudo -u fff node /tmp/fff-ops-sock.js" || true)
echo "$out"
printf '%s\n' "$out" | head -n 1 | matches -x OK || fail "the launcher did not answer OK through the socket: $out"
printf '%s' "$out" | matches 'Claude Code' || fail "Claude Code did not run as the worker: $out"
out=$(g 'sudo -u fff node /tmp/fff-ops-sock.js 0.0.1' || true)
printf '%s' "$out" | matches '^ERR .*0\.0\.1' || fail "the launcher took another SDK version: $out"
if g 'sudo -u fff-ops node /tmp/fff-ops-sock.js' 2>/dev/null | matches '^OK'; then fail "fff-ops itself could connect to the socket"; fi
# Kept for the update step below: the worker's way in must survive the portal's restart.
# The unit's own fences, as installed.
unit=$(g 'systemctl cat fff-ops@.service' || true)
for want in 'User=fff-ops' 'ProtectSystem=strict' 'IPAddressDeny=any' 'IPAddressAllow=127.0.0.0/8 ::1/128 160.79.104.0/23' 'TemporaryFileSystem=/tmp:size=64M' 'MemoryMax=' 'RuntimeMaxSec='; do
  printf '%s' "$unit" | matches -F "$want" || fail "fff-ops@.service has no $want"
done
# The same fences around a probe (the unit's own settings, as installed, on a transient unit): sudo's two wrappers work
# inside them, the network reaches Anthropic's API and nothing else, and only its scratch is writable.
props=$(printf '%s
' "$unit" | grep -E '^(User|Group|NoNewPrivileges|ProtectSystem|ProtectHome|ReadWritePaths|TemporaryFileSystem|IPAddressDeny|IPAddressAllow|MemoryMax|TasksMax)=' | sed "s/.*/-p '&'/" | paste -sd' ' -)
probe() { g "sudo systemd-run --quiet --wait --pipe --collect $props -- $1"; }
probe '/usr/bin/sudo -n /usr/local/lib/fff/fff-ops-priv status' | matches '^portal: active' || fail "fffctl status does not work inside the worker's fences"
probe '/usr/bin/sudo -n /usr/local/lib/fff/fff-ops-priv credential list' >/dev/null || fail "fffctl credential list does not work inside the worker's fences"
out=$(probe '/usr/bin/sudo -n /usr/local/lib/fff/fff-ops-priv credential issue ci-m3 --to nosuchhost.invalid' 2>&1 || true)
printf '%s' "$out" | matches 'does not answer ssh' || fail "the worker's ssh check does not run inside its fences: $out"
code=$(probe '/usr/bin/curl -sS -m 20 -o /dev/null -w %{http_code} https://api.anthropic.com/v1/messages' 2>&1 || true)
printf '%s' "$code" | matches -E '^[1-5][0-9][0-9]$' || fail "the worker cannot reach Anthropic's API: $code"
if probe '/usr/bin/curl -fsS -m 10 -o /dev/null https://example.com' >/dev/null 2>&1; then fail "the worker reached example.com: downloads are not fenced"; fi
if probe '/usr/bin/touch /var/lib/fff-ops-probe' >/dev/null 2>&1; then fail "the worker wrote outside its scratch"; fi
probe '/usr/bin/touch /srv/fff-ops/scratch/probe' || fail "the worker cannot write its scratch"
g 'sudo rm -f /srv/fff-ops/scratch/probe'
# scp and sftp (w612), inside the same fences, to a machine of CI's own: an sshd on the guest's loopback (port 2222, one
# account, the portal's public key), its host key pinned and its alias written into the portal account's ssh files as an
# enrolled machine's are. The same sshd under another name (its key not pinned for that name) is an unenrolled host.
cat >/tmp/fff-ops-scp-setup.sh <<'SETUP'
set -e
useradd --create-home --shell /bin/bash ffci-scp
usermod -p '*' ffci-scp
install -d -m 0700 -o ffci-scp -g ffci-scp ~ffci-scp/.ssh
install -m 0600 -o ffci-scp -g ffci-scp /srv/fff/home/.ssh/id_ed25519.pub ~ffci-scp/.ssh/authorized_keys
cat >/etc/ssh/ci-scp.conf <<'EOF'
Port 2222
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/ci-scp-sshd.pid
AllowUsers ffci-scp
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
Subsystem sftp internal-sftp
EOF
install -d -m 0755 /run/sshd
/usr/sbin/sshd -f /etc/ssh/ci-scp.conf
printf '# w612-ci-begin\nHost ci-scp ci-unpinned\n  Port 2222\n  User ffci-scp\nHost ci-scp\n  HostName 127.0.0.1\nHost ci-unpinned\n  HostName localhost\n# w612-ci-end\n' >>/srv/fff/home/.ssh/config
echo "[127.0.0.1]:2222 $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" >>/srv/fff/home/.ssh/known_hosts
echo down-ci >~ffci-scp/down.txt
chown ffci-scp: ~ffci-scp/down.txt
echo up-ci | sudo -u fff-ops tee /srv/fff-ops/scratch/up.txt >/dev/null
printf 'put /srv/fff-ops/scratch/up.txt sftp.txt\nget down.txt /srv/fff-ops/scratch/sftp-down.txt\n' | sudo -u fff-ops tee /srv/fff-ops/scratch/batch >/dev/null
SETUP
g "echo $(base64 -w0 /tmp/fff-ops-scp-setup.sh) | base64 -d | sudo bash" || fail "could not set up CI's scp machine in the guest"
scp_ops=/usr/local/lib/fff/ops-bin
probe "$scp_ops/scp /srv/fff-ops/scratch/up.txt ci-scp:up.txt" || fail "the worker's scp to an enrolled machine failed"
[ "$(g 'sudo cat ~ffci-scp/up.txt')" = up-ci ] || fail "the worker's scp did not copy its file to the machine"
probe "$scp_ops/scp ci-scp:down.txt /srv/fff-ops/scratch/down.txt" || fail "the worker's scp from an enrolled machine failed"
[ "$(g 'sudo cat /srv/fff-ops/scratch/down.txt')" = down-ci ] || fail "the worker's scp did not fetch the machine's file"
probe "$scp_ops/scp -O /srv/fff-ops/scratch/up.txt ci-scp:legacy.txt" || fail "the worker's scp -O (legacy) failed"
[ "$(g 'sudo cat ~ffci-scp/legacy.txt')" = up-ci ] || fail "the worker's scp -O did not copy"
probe "$scp_ops/sftp -b /srv/fff-ops/scratch/batch ci-scp" >/dev/null || fail "the worker's sftp batch failed"
[ "$(g 'sudo cat ~ffci-scp/sftp.txt /srv/fff-ops/scratch/sftp-down.txt' | paste -sd' ' -)" = 'up-ci down-ci' ] || fail "the worker's sftp did not put and get"
g 'sudo journalctl -t fff-ops-ssh --no-pager -n 50' | matches -E 'sftp (ffci-scp@)?ci-scp' || fail "the worker's sftp is not in the journal (fff-ops-ssh)"
echo "ok: the worker's scp (both ways, and scp -O) and sftp reach an enrolled machine with the portal's key"
# Refused: a host whose key is not pinned, a host outside its network fence, an ssh option, and the portal's secrets.
if out=$(probe "$scp_ops/scp /srv/fff-ops/scratch/up.txt ci-unpinned:unpinned.txt" 2>&1); then fail "scp to a host whose key is not pinned worked"; fi
echo "MEASURE scp to an unpinned host: $out"
printf '%s' "$out" | matches 'Host key verification failed' || fail "scp to an unpinned host failed, but not on its host key: $out"
if out=$(probe "$scp_ops/scp /srv/fff-ops/scratch/up.txt example.com:x.txt" 2>&1); then fail "scp to example.com worked"; fi
echo "MEASURE scp to example.com: $out"
if out=$(probe "$scp_ops/scp -o ProxyCommand=id /srv/fff-ops/scratch/up.txt ci-scp:proxy.txt" 2>&1); then fail "scp -o ProxyCommand worked"; fi
printf '%s' "$out" | matches 'is not taken' || fail "scp -o ProxyCommand failed, but not on the option: $out"
for secret in /srv/fff/config/config.json /srv/fff/home/.ssh/id_ed25519 /etc/fff/vault.key; do
  if out=$(probe "$scp_ops/scp $secret ci-scp:stolen" 2>&1); then fail "the worker's scp copied $secret"; fi
  echo "MEASURE scp $secret: $out"
  printf '%s' "$out" | matches -i 'permission denied' || fail "scp of $secret failed, but not on its permissions: $out"
done
for f in unpinned.txt x.txt proxy.txt stolen; do
  if g "sudo test -e ~ffci-scp/$f"; then fail "a refused copy reached the machine: $f"; fi
done
echo "ok: the worker's scp refuses an unpinned host, a host outside its fences, an ssh option and the portal's secrets"
g 'sudo kill "$(cat /run/ci-scp-sshd.pid)"; sudo sed -i "/^# w612-ci-begin/,/^# w612-ci-end/d" /srv/fff/home/.ssh/config; sudo -u fff ssh-keygen -R "[127.0.0.1]:2222" -f /srv/fff/home/.ssh/known_hosts >/dev/null 2>&1; sudo rm -f /srv/fff/home/.ssh/known_hosts.old /etc/ssh/ci-scp.conf /srv/fff-ops/scratch/up.txt /srv/fff-ops/scratch/down.txt /srv/fff-ops/scratch/batch /srv/fff-ops/scratch/sftp-down.txt; sudo userdel -r ffci-scp 2>/dev/null; true'
rm -f /tmp/fff-ops-scp-setup.sh
echo "ok: the orchestration worker: its own account, a 2 GiB noexec scratch that fills up alone, a socket only the portal opens, two sudo rights, and Claude Code through the launcher"

step "update: build beside the running portal, drain, switch, verify"
before=$(sha_of)
git -C "$ROOT" -c user.name=ci -c user.email=ci@users.noreply.github.com commit -q --allow-empty -m "ci: an update to install"
main_at_head
git -C "$ROOT" bundle create /tmp/ff.bundle HEAD main
g 'cat > /tmp/ff.bundle.new && mv /tmp/ff.bundle.new /tmp/ff.bundle && chmod 644 /tmp/ff.bundle' </tmp/ff.bundle
want=$(git -C "$ROOT" rev-parse --short=7 HEAD)
# Blocking (w517): it returns once the new release is verified, having shown each stage.
t0=$(date +%s)
set +e
out=$(g 'sudo fffctl update --drain-minutes 0' 2>&1)
rc=$?
set -e
echo "$out"
[ "$rc" = 0 ] || fail "fffctl update: exit $rc, not 0"
printf '%s' "$out" | matches -E 'built [0-9a-f]{12} in ' || fail "fffctl update did not say what it built"
printf '%s' "$out" | matches -E '^verified: [0-9a-f]{12} runs' || fail "fffctl update did not wait for the verification"
echo "MEASURE blocking update: $(($(date +%s) - t0)) s from fffctl update to its 'verified'"
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
out=$(g 'sudo fffctl update --drain-minutes 0' 2>&1)
echo "$out"
printf '%s' "$out" | matches -E "^already up to date at $want" || fail "a second fffctl update did not say it was already up to date"
# The orchestration worker (w597) after that restart: its socket still listens and Claude Code still starts through it.
# Its process lives in fff-ops@.service, not in the portal's unit, so a portal restart ends only its connection.
g 'systemctl is-active fff-ops.socket' | matches -x active || fail "fff-ops.socket did not survive the portal's update"
g 'sudo -u fff node /tmp/fff-ops-sock.js' | head -n 1 | matches -x OK || fail "the worker's launcher does not answer after the portal's update"
# Its deploy: fffctl update through its wrapper is refused without the grant the portal leaves on ops_worker deploy, and
# with one that ran out; a fresh one is used once, asks for the update and is gone.
grant() { g "echo $(printf '{"by":"ci","name":"CI","at":"%s","expires":"%s"}' "$(date -u +%FT%TZ)" "$1" | base64 -w0) | base64 -d | sudo -u fff tee /srv/fff/data/ops-deploy.grant >/dev/null"; }
out=$(g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl update 2>&1' || true)
printf '%s' "$out" | matches 'no deploy was asked for' || fail "the worker's fffctl update ran without a grant: $out"
grant 2020-01-01T00:00:00Z
out=$(g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl update 2>&1' || true)
printf '%s' "$out" | matches 'ran out' || fail "the worker's fffctl update took a grant that ran out: $out"
g 'test ! -e /srv/fff/data/ops-deploy.grant' || fail "a grant that ran out was not removed"
grant "$(date -u -d '+10 min' +%FT%TZ)"
since=$(g 'date +%s')
out=$(g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl update 2>&1' || true)
echo "$out"
printf '%s' "$out" | matches "deploy asked for by ci; the portal runs .* at commit $want" || fail "the worker's deploy did not say what it started from: $out"
g 'test ! -e /srv/fff/data/ops-deploy.grant' || fail "the deploy grant was not used up"
out=$(g 'sudo -u fff-ops /usr/local/lib/fff/ops-bin/fffctl update 2>&1' || true)
printf '%s' "$out" | matches 'no deploy was asked for' || fail "a deploy grant worked twice: $out"
# Finished means fff-update ran for it and ended, not only that it is idle now (the path unit may not have fired yet): a
# request still running would answer the next step's update for it.
wait_for 600 "the worker's update request finished (already up to date)" g "test ! -e /srv/fff/data/update.wanted && ! systemctl is-active --quiet fff-update.service && sudo journalctl -u fff-update.service --since @$since -o cat --no-pager | grep -E 'Deactivated successfully|Finished|Failed with result' >/dev/null"
wait_for 300 "the portal answers after the worker's update request" health
[ "$(sha_of)" = "$want" ] || fail "the portal does not run $want after the worker's update request"
g 'rm -f /tmp/fff-ops-sock.js'
echo "ok: the orchestration worker survives the portal's update, and deploys only with a fresh grant, once"

step "a broken update is rolled back by itself"
good=$want
sed -i '1i throw new Error("ci: broken on purpose");' "$ROOT/server/index.ts"
git -C "$ROOT" -c user.name=ci -c user.email=ci@users.noreply.github.com commit -q -am "ci: a broken update"
main_at_head
git -C "$ROOT" bundle create /tmp/ff.bundle HEAD main
g 'cat > /tmp/ff.bundle.new && mv /tmp/ff.bundle.new /tmp/ff.bundle && chmod 644 /tmp/ff.bundle' </tmp/ff.bundle
# Blocking: it ends with the rollback and exit 1. Expected within about a minute (fast: 45 s, checks every 10 s) or 6
# (production: 5 min); on a timeout, say why first.
t0=$(date +%s)
set +e
out=$(g 'sudo fffctl update --drain-minutes 0' 2>&1)
rc=$?
set -e
echo "$out"
[ "$rc" = 1 ] || fail "fffctl update of a broken commit: exit $rc, not 1"
printf '%s' "$out" | matches 'the update FAILED: rolled back' || fail "fffctl update did not say it was rolled back"
printf '%s' "$out" | matches 'journalctl -u fff-update' || fail "fffctl update did not say where the details are"
until g 'sudo cat /srv/fff/data/update.result.json' 2>/dev/null | jq -e '.ok == false and (.error | test("rolled back"))' >/dev/null 2>&1; do
  if [ $(($(date +%s) - t0)) -ge "$([ "$TIMING" = fast ] && echo 240 || echo 600)" ]; then
    g 'sudo fffctl status; sudo cat /srv/fff/data/update.result.json /srv/fff/data/update.verifying.json; sudo ls -la /srv/fff/app /srv/fff/data; sudo journalctl --no-pager -n 60 -u fff-update -u fff-health -u fff-portal' || true
    fail "no rollback in time"
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
# The guest install masked tmp.mount (w537): from this boot on, /tmp is on the root disk, not a tmpfs of half the RAM.
[ "$(g 'systemctl is-enabled tmp.mount' || true)" = masked ] || fail "the guest install did not mask tmp.mount"
if g 'findmnt -n /tmp' >/dev/null 2>&1; then fail "/tmp is still its own mount after a boot: $(g 'findmnt -n /tmp')"; fi
[ "$(g 'df --output=target /tmp | tail -n 1')" = / ] || fail "/tmp is not on the root filesystem"
echo "MEASURE /tmp after the nightly boot: $(g 'df -h --output=source,fstype,size,avail /tmp | tail -n 1')"

step "a size change in fff-vm.conf: install.sh leaves the running VM alone, the nightly applies it (w537)"
mem_kib() { virsh dumpxml "$@" $VM | sed -n "s|.*<memory unit='KiB'>\([0-9]*\)</memory>.*|\1|p"; }
[ "$(mem_kib --inactive)" = 4194304 ] || fail "the VM is not defined at the default 4096 MiB: $(mem_kib --inactive) KiB"
sed -i '/^VM_MEMORY_MB=/d' /etc/fff-vm/fff-vm.conf
echo 'VM_MEMORY_MB=3072' >>/etc/fff-vm/fff-vm.conf
pid1=$(cat /run/libvirt/qemu/$VM.pid)
deploy/vm/host/install.sh --host-only 2>&1 | tee /tmp/resize-install.log
[ "$(cat /run/libvirt/qemu/$VM.pid)" = "$pid1" ] || fail "install.sh restarted the VM for a size change"
matches -F 'fff-vm.conf changes the running domain (memory 4096 -> 3072 MiB): fff-vm nightly applies it' /tmp/resize-install.log ||
  fail "install.sh did not say the nightly applies the change"
[ "$(mem_kib --inactive)" = 4194304 ] || fail "install.sh redefined the running VM"
/usr/local/sbin/fff-vm status | tee /tmp/resize-status.txt
matches -F 'definition: fff-vm.conf asks for memory 4096 -> 3072 MiB: the next nightly applies it' /tmp/resize-status.txt ||
  fail "fff-vm status does not show the pending change"
b1=$(boot_id)
/usr/local/sbin/fff-vm nightly --now 2>&1 | tee /tmp/resize-nightly.log
matches -F 'applying fff-vm.conf to fff-portal: memory 4096 -> 3072 MiB' /tmp/resize-nightly.log || fail "the nightly did not log the change"
matches -F 'applied: memory 4096 -> 3072 MiB' /tmp/resize-nightly.log || fail "the nightly did not apply the change"
! matches 'notify' /tmp/resize-nightly.log || fail "the nightly alerted"
[ "$(boot_id)" != "$b1" ] || fail "the guest did not boot again"
[ "$(mem_kib --inactive)" = 3145728 ] || fail "the VM is not defined at 3072 MiB: $(mem_kib --inactive) KiB"
[ "$(mem_kib)" = 3145728 ] || fail "the VM does not run at 3072 MiB: $(mem_kib) KiB"
virsh dominfo $VM | grep -i memory
matches "<memory unit='KiB'>4194304</memory>" /etc/fff-vm/domain.libvirt-prev.xml || fail "the previous definition is not kept"
wait_for 300 "the portal answers after the resize" health
gtotal=$(g "free -m | awk '/^Mem:/ {print \$2}'")
echo "MEASURE guest memory after the resize to 3072 MiB: total $gtotal MiB"
[ "$gtotal" -gt 2600 ] || fail "the guest sees $gtotal MiB, not about 3 GiB"
[ "$gtotal" -le 3072 ] || fail "the guest sees $gtotal MiB, more than 3 GiB"
/usr/local/sbin/fff-vm status | tee /tmp/resize-status.txt
matches -E '^VM fff-portal: running \(2 vCPUs, 3072 MiB' /tmp/resize-status.txt || fail "fff-vm status does not show the new size"
matches -Fx '  definition: matches fff-vm.conf' /tmp/resize-status.txt || fail "fff-vm status does not say it matches"
echo "ok: 4096 -> 3072 MiB by the nightly; install.sh left the running VM alone"

step "a size libvirt cannot run: the nightly goes back to the previous definition (w537)"
echo 'VM_VCPUS=5000' >>/etc/fff-vm/fff-vm.conf
/usr/local/sbin/fff-vm nightly --now 2>&1 | tee /tmp/bad-nightly.log
matches -E 'notify: fff-vm: VM settings (not applied|rolled back)' /tmp/bad-nightly.log || fail "no alert about the refused size"
echo "MEASURE where libvirt refused 5000 vCPUs: $(grep -oE 'notify: fff-vm: VM settings (not applied|rolled back): .{0,300}' /tmp/bad-nightly.log | head -n 1)"
virsh dominfo $VM | matches -E '^CPU\(s\): +2$' || fail "the VM does not run its previous 2 vCPUs"
[ "$(virsh dumpxml --inactive $VM | sed -n "s|.*<vcpu[^>]*>\([0-9]*\)</vcpu>.*|\1|p")" = 2 ] || fail "the VM is not defined with its previous 2 vCPUs"
wait_for 300 "the portal answers after going back" health
/usr/local/sbin/fff-vm status | matches -F 'not tried again until fff-vm.conf changes' || fail "fff-vm status does not show the rejected size"
sed -i '/^VM_VCPUS=5000$/d' /etc/fff-vm/fff-vm.conf
/usr/local/sbin/fff-vm status | matches -Fx '  definition: matches fff-vm.conf' || fail "fff-vm status after fff-vm.conf is put back"
echo "ok: a size libvirt cannot run is not kept; the VM runs its previous definition"

step "hang detection: neither the agent nor the portal answers -> reset"
b1=$(boot_id)
since=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
g 'sudo systemctl stop fff-health.timer fff-portal qemu-guest-agent' || true
wait_for 900 "the watch reset the VM" rebooted_since "$b1"
# Read the whole journal first: grep -m1 stops at its match and journalctl, still writing, dies of SIGPIPE, which
# pipefail turns into a failure (a 10 s watch writes enough lines for that; main run 37420115848). Only this step's
# lines: a reset during the first boot is in the journal too.
watch_log=$(journalctl -u fff-vm-watch --no-pager --since "$since")
tail -n 30 <<<"$watch_log"
grep -q 'resetting' <<<"$watch_log" || fail "no reset in the watch's log since $since"
wait_for 300 "the portal answers after the reset" health

step "watchdog device: a guest that stops petting it is reset"
b1=$(boot_id)
wait_for 300 "watchdog0 armed again" g 'test "$(cat /sys/class/watchdog/watchdog0/state)" = active'
systemctl stop fff-vm-watch.timer
# PID 1 lets go of the device cleanly, then a process opens it and dies without the magic close: nobody pets it.
g 'printf "[Manager]\nRuntimeWatchdogSec=off\n" | sudo tee /etc/systemd/system.conf.d/99-ci.conf >/dev/null && sudo systemctl daemon-reexec'
g "sudo sh -c 'exec 3>/dev/watchdog; echo x >&3; kill -9 \$\$'" || true
wait_for 300 "the watchdog reset the VM" rebooted_since "$b1"
events_log=$(journalctl -u fff-vm-events --no-pager)
grep -m1 'watchdog fired' <<<"$events_log" || fail "fff-vm events did not see the watchdog"
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
