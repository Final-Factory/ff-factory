#!/usr/bin/env bash
# Install the FF Factory portal inside its VM (docs/portal-on-ffbox-host.md, "Installing"). Run as root in the VM:
#
#   git clone https://github.com/Final-Factory/ff-factory.git && sudo ff-factory/deploy/vm/guest/install.sh [--dry-run]
#   options: --repo URL (default FFF_REPO_URL)  --ref REF (default origin/<FFF_BRANCH>)  --no-start
#            --no-todo (no list of what is left: the host's install.sh, which runs this, does those steps itself)
#
# Idempotent. It installs Node (CI's major version), git, git-lfs, gh, ssh, age, Tailscale and the Claude Code CLI;
# the "fff" service account and /srv/fff; ff-factory as a release (fff-update); config.json from the VM template
# (never overwritten); the portal's systemd units (service, health check, updater, backup, base-clone refresh) and
# the VM's own firewall. What needs a person (Lothsahn's Claude login, the Tailscale join, the GitHub token, the
# base clone, the backup keys) is listed at the end, each one an fffctl command.
set -o errexit -o nounset -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
REPO_URL=""
REF=""
START=1
TODO=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --repo) REPO_URL=$2; shift ;;
    --ref) REF=$2; shift ;;
    --no-start) START=0 ;;
    --no-todo) TODO=0 ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
need_root
load_conf
[ -z "$REPO_URL" ] || FFF_REPO_URL=$REPO_URL
[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing will be changed"

log "1/10 preflight"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu only (this is ${PRETTY_NAME:-unknown})"
[ -d /run/systemd/system ] || die "systemd is not running"
log "guest: $PRETTY_NAME, $(nproc) vCPUs, $(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo), $(df -h --output=avail / | tail -n 1 | xargs) free on /"
[ -f /etc/fff-vm-guest.env ] || warn "no /etc/fff-vm-guest.env (made by the host's cloud-init): not the portal VM? The firewall gets no rule for the host's health check"
curl -fsS -m 15 -o /dev/null "https://deb.nodesource.com/node_$NODE_MAJOR.x/dists/nodistro/Release" || die "no route to the internet (deb.nodesource.com)"
# /tmp on the root disk, not in RAM (w537). Ubuntu 26.04 mounts it as a tmpfs (its release notes: "the /tmp directory is
# now a tmpfs file system by default"), half the RAM in systemd's tmp.mount (size=50%): 1.9 GiB in the 4 GiB VM, which
# has no swap. The agents' temp folders (TMPDIR=/tmp/ffa-<session>) would take memory from the portal there, and the
# portal's clean-up counts /tmp as free disk space (server/cleanup.ts), so it reported 1.9 GB free on the first day.
# systemd's way back to the disk (docs/API_FILE_SYSTEMS.md): mask tmp.mount. It applies from the next boot.
if [ "$(systemctl is-enabled tmp.mount 2>/dev/null || true)" != masked ]; then
  run_cmd systemctl mask tmp.mount
  if [ "$(findmnt -n -o FSTYPE /tmp 2>/dev/null || true)" = tmpfs ]; then log "/tmp is a tmpfs until the VM's next boot (fff-vm nightly restarts it every night)"; fi
fi

log "2/10 apt sources: NodeSource node_$NODE_MAJOR.x, GitHub CLI, Tailscale"
codename=${VERSION_CODENAME:?}
# Each repository has its own keyring (signed-by= in its source line below), and its key is trusted only by a pinned
# fingerprint (w5530, security audit finding 22): downloaded to a temp file, checked by verify_key_fprs (lib.sh; a
# mismatch aborts the install before anything is written), then written to the keyring. A keyring already there is
# checked the same way, so a rerun also catches a swapped key.
# Where each fingerprint comes from (read 2026-11-24):
#  - GitHub CLI: the two fingerprints github.com/cli/cli docs/install_linux.md lists for its packages and repository
#    metadata. The 2C61... key expires 2026-09 and 7F38... replaces it; the keyring file holds both, so both are pinned.
#  - NodeSource 6F71F525...: the key served at deb.nodesource.com/gpgkey/nodesource-repo.gpg.key ("NSolid
#    <nsolid-gpg@nodesource.com>", created 2016, re-signed 2026, same fingerprint). NodeSource's docs
#    (github.com/nodesource/distributions) publish no fingerprint: this one was read from the vendor's own key URL over TLS.
#  - Tailscale 2596A99E...: "Tailscale Inc. (Package repository signing key)", identical in the jammy and noble files at
#    pkgs.tailscale.com/stable/ubuntu. Tailscale's docs publish no fingerprint either: read from pkgs.tailscale.com over TLS.
# A vendor that rotates its key makes this fail loudly: take the new fingerprint from the vendor's docs, not the download.
FPR_NODESOURCE=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
FPR_GITHUB_CLI=(2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325)
FPR_TAILSCALE=2596A99EAAB33821893C0A79458CA832957F5868
key() { # URL DEST dearmor|raw FINGERPRINT...
  local url=$1 dest=$2 mode=$3 tmp
  shift 3
  if [ -s "$dest" ]; then verify_key_fprs "$dest" "$@"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would fetch the key $url, check it against $*, and write it to $dest"; return 0; fi
  tmp=$(mktemp)
  curl -fsSL -o "$tmp" "$url" || { rm -f "$tmp"; die "could not download the apt key $url"; }
  (verify_key_fprs "$tmp" "$@") || { rm -f "$tmp"; exit 1; }
  install -d -m 0755 "$(dirname "$dest")"
  if [ "$mode" = dearmor ]; then gpg --batch --yes --dearmor -o "$dest" <"$tmp"; else cp "$tmp" "$dest"; fi
  rm -f "$tmp"
  chmod 0644 "$dest"
}
key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /etc/apt/keyrings/nodesource.gpg dearmor "$FPR_NODESOURCE"
key https://cli.github.com/packages/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg raw "${FPR_GITHUB_CLI[@]}"
key "https://pkgs.tailscale.com/stable/ubuntu/$codename.noarmor.gpg" /usr/share/keyrings/tailscale-archive-keyring.gpg raw "$FPR_TAILSCALE"
c=""
c+=$(echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | write_file /etc/apt/sources.list.d/nodesource.list 0644)
c+=$(printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' | write_file /etc/apt/preferences.d/nodesource 0644)
c+=$(echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | write_file /etc/apt/sources.list.d/github-cli.list 0644)
c+=$(echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu $codename main" | write_file /etc/apt/sources.list.d/tailscale.list 0644)
# Security updates for these too, not only Ubuntu's (unattended-upgrades' "site=" pattern). Not Tailscale's (w2474): its
# upgrade restarts tailscaled, which drops every machine's link to the portal (2026-10-28 11:07 UTC, from the 11:00 run).
# fffctl prepare-shutdown upgrades it instead, with the portal stopped for the host's nightly restart.
write_file /etc/apt/apt.conf.d/53fff-third-party 0644 >/dev/null <<'EOF'
// deploy/vm/guest: unattended-upgrades also takes Node (within its major version) and gh. Tailscale is upgraded by
// fffctl prepare-shutdown in the nightly restart (w2474), never by this daytime run.
Unattended-Upgrade::Origins-Pattern {
  "site=deb.nodesource.com";
  "site=cli.github.com";
};
Unattended-Upgrade::Package-Blacklist {
  "tailscale$";
};
EOF

log "3/10 packages"
# zstd and bzip2: fffctl migrate unpacks BEAST's copy with them (w517).
# e2fsprogs: the orchestration worker's scratch file system (w597).
# ffmpeg: the web previews of review videos the chat plays (server/videoPreview.ts, w1248).
# python3: the merge-on-green pilot runs pr_evidence.py on the portal (machine/evidenceGate.ts portalPrEvidence, w3110).
# acl: setfacl lets the build account (FFF_BUILD_USER) pass through $FFF_ROOT to the release it builds (w5523).
pkgs=(nodejs git git-lfs gh python3 openssh-client openssh-server tailscale age rsync jq curl ca-certificates nftables util-linux unattended-upgrades zstd bzip2 e2fsprogs ffmpeg acl)
missing=()
for p in "${pkgs[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | matches 'install ok installed' || missing+=("$p"); done
if [ -n "$c" ] || [ ${#missing[@]} -gt 0 ]; then run_cmd env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -q; fi
if [ ${#missing[@]} -gt 0 ]; then run_cmd env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends "${missing[@]}"; fi
if [ "$DRY_RUN" != 1 ]; then
  have=$(node -p 'process.versions.node.split(".")[0]')
  [ "$have" = "$NODE_MAJOR" ] || die "node is $have, not $NODE_MAJOR (another nodejs package won?)"
  log "node $(node --version), npm $(npm --version), git $(git --version | cut -d' ' -f3), gh $(gh --version | head -n 1 | cut -d' ' -f3), tailscale $(tailscale version | head -n 1)"
fi

log "4/10 the fff account and $FFF_ROOT"
if ! id "$FFF_USER" >/dev/null 2>&1; then
  # Its home is made below, inside $FFF_ROOT, which does not exist yet.
  run_cmd useradd --system --user-group --home-dir "$FFF_ROOT/home" --no-create-home --shell /bin/bash --comment 'FF Factory portal' "$FFF_USER"
fi
run_cmd passwd -l "$FFF_USER" >/dev/null
# $FFF_ROOT is root's with fff's group and the sticky bit, and the release folders are root's (w5505): fff makes and
# owns its folders here, but cannot rename or replace /app, whose release trees, record and links root trusts.
run_cmd install -d -m 1770 -o root -g "$FFF_USER" "$FFF_ROOT"
run_cmd chown "root:$FFF_USER" "$FFF_ROOT"
run_cmd chmod 1770 "$FFF_ROOT"
# fff's own folders: fff can swap any of them for a symbolic link, so fff_dir (lib.sh, w5531) refuses one and never
# follows it, where install -d -o would have given the link's target to fff.
for d in /home /config /data /agents /review /sandboxes /secrets; do
  fff_dir "$FFF_ROOT$d"
done
run_cmd install -d -m 0755 -o root -g root "$FFF_ROOT/app"
run_cmd install -d -m 0700 -o root -g root "$FFF_ROOT/backup"
run_cmd install -d -m 0755 /etc/fff
[ -f "$FFF_CONF" ] || write_file "$FFF_CONF" 0644 >/dev/null <<EOF
# Settings for the FF Factory portal in this VM. Defaults and what each means: /usr/local/lib/fff/fff.conf.example.
EOF
# --repo is remembered: the updater reads it from here later.
if [ -n "$REPO_URL" ] && ! matches -xF "FFF_REPO_URL=$REPO_URL" "$FFF_CONF" 2>/dev/null; then
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would set FFF_REPO_URL=$REPO_URL in $FFF_CONF"; else
    sed -i '/^FFF_REPO_URL=/d' "$FFF_CONF"
    echo "FFF_REPO_URL=$REPO_URL" >>"$FFF_CONF"
  fi
fi
# The token vault's key (docs/vault.md): 32 random bytes, root only, never in the data folder or a backup.
if [ ! -s "$FFF_VAULT_KEY" ]; then
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would make the vault key $FFF_VAULT_KEY (0600, root)"; else
    (umask 077 && head -c 32 /dev/urandom | base64 >"$FFF_VAULT_KEY")
    chmod 0600 "$FFF_VAULT_KEY"
  fi
fi
if [ ! -f "$BACKUP_SSH_KEY" ]; then
  run_cmd ssh-keygen -q -t ed25519 -N '' -C "fff-backup@$(hostname -s)" -f "$BACKUP_SSH_KEY"
fi
if [ ! -f "$FFF_ROOT/home/.ssh/id_ed25519" ]; then
  # The portal's own key for deploying machine daemons (docs, 4.3): authorize its .pub with from= on each machine.
  fff_dir "$FFF_ROOT/home/.ssh"
  [ "$DRY_RUN" = 1 ] || as_fff ssh-keygen -q -t ed25519 -N '' -C "fff-portal@$(hostname -s)" -f "$FFF_ROOT/home/.ssh/id_ed25519"
fi
# The server reads Max's Discord token from here (server/discordConfig.ts): the portal's own copy, never FFBox's.
fff_dir "$FFF_ROOT/home/.config" "$FFF_ROOT/home/.config/ffbox"

log "5/10 the VM's own firewall (table inet fff_guest)"
host_rule=""
[ -z "$FFF_HOST_IP" ] || host_rule="ip saddr $FFF_HOST_IP tcp dport { 22, $FFF_PORT } accept comment \"the host's root: health check and fff-vm ssh\""
fw=$(write_file /etc/fff/guest.nft 0600 <<EOF
#!/usr/sbin/nft -f
# deploy/vm/guest: the portal VM's own firewall, behind the host's (table inet fff_vm there). Only this table.
table inet fff_guest
delete table inet fff_guest
table inet fff_guest {
  comment "fff guest: the FF Factory portal VM's own firewall (deploy/vm/guest)"
  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto { icmp, ipv6-icmp } accept
    $host_rule
    # What the tailnet may reach on this VM's own processes (w683): ssh, and 443. Nothing else is accepted on tailscale0.
    # Not needed here, by tailscaled's source (wgengine/netstack shouldProcessInbound): Funnel's servers connect to tailscaled's
    # peer API port (a random one per address, /v0/ingress) and tailscale serve's 443, and tailscaled's own netstack takes
    # both off the wire before the kernel, so the packets never reach this chain. 443 stays, counted, as the portal's door
    # should tailscaled ever hand it to the kernel; if its counter stays 0 under real traffic it can go.
    # The counters answer "what does this chain see on tailscale0": sudo nft list chain inet fff_guest input
    iifname "tailscale0" tcp dport 443 counter accept comment "tailnet HTTPS (tailscale serve) to the portal; tailscaled normally takes it before the kernel"
    iifname "tailscale0" tcp dport 22 counter accept comment "ssh from the tailnet only: the tailnet policy says who; Funnel never carries 22"
    iifname "tailscale0" counter drop comment "everything else from the tailnet, counted"
    udp dport 41641 accept comment "Tailscale's direct connections"
  }
}
EOF
)
c=""
c+=$(write_file /etc/systemd/system/fff-guest-firewall.service 0644 <"$here/units/fff-guest-firewall.service")
[ -z "$c" ] || run_cmd systemctl daemon-reload
run_cmd systemctl enable fff-guest-firewall.service
if [ -n "$fw$c" ] || ! nft list table inet fff_guest >/dev/null 2>&1; then run_cmd systemctl reload-or-restart fff-guest-firewall.service; fi
# ssh: keys only, the admin account only (the host's cloud-init made it and named it in /etc/fff-vm-guest.env).
sshd=$(write_file /etc/ssh/sshd_config.d/60-fff.conf 0644 <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
${FFF_ADMIN_USER:+AllowUsers $FFF_ADMIN_USER}
EOF
)
# Ubuntu 24.04 and later start sshd from ssh.socket: reload it only if it runs (a new one reads the file anyway).
if [ -n "$sshd" ]; then run_cmd sshd -t && run_cmd systemctl try-reload-or-restart ssh.service; fi

log "6/10 scripts: fffctl, fff-update, fff-health, fff-backup, fff-base-refresh, fff-migrate, fff-machine-ssh, the orchestration worker's"
install_scripts "$here" >/dev/null
# The machines the portal deploys daemons to: their ssh aliases and pinned host keys (machines.ssh, w537). The cut-over
# left a VM without them, and every daemon redeploy failed on "Host key verification failed".
if [ "$DRY_RUN" = 1 ]; then
  log "DRY-RUN would write the machines' ssh aliases and pinned host keys (fff-machine-ssh --fix)"
else
  as_fff "$FFF_LIB/fff-machine-ssh" --fix || warn "fff-machine-ssh: not every machine answers yet (above); the aliases and pinned keys are written"
fi

log "7/10 ff-factory: the first release (fff-update init)"
if [ "$DRY_RUN" = 1 ]; then
  log "DRY-RUN would clone $FFF_REPO_URL into $FFF_ROOT/app/repo.git and build ${REF:-origin/$FFF_BRANCH} (npm ci, web build)"
else
  FFF_REPO_URL=$FFF_REPO_URL "$FFF_LIB/fff-update" init "${REF:-origin/$FFF_BRANCH}"
fi
log "Claude Code CLI (for /login only: the server runs the Agent SDK's own binary)"
if [ -x "$FFF_ROOT/home/.local/bin/claude" ]; then
  log "present: $(as_fff "$FFF_ROOT/home/.local/bin/claude" --version 2>/dev/null || echo '?')"
elif [ "$DRY_RUN" = 1 ]; then
  log "DRY-RUN would run the native installer (curl -fsSL https://claude.ai/install.sh | bash) as $FFF_USER"
else
  as_fff bash -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash' || warn "the Claude Code CLI did not install (rerun install.sh)"
fi

log "8/10 config.json"
if [ -f "$FFF_ROOT/config/config.json" ]; then
  log "kept: $FFF_ROOT/config/config.json"
else
  # Written by fff (fff_write, w5531): a link fff left at the name would have led root's write elsewhere.
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would write $FFF_ROOT/config/config.json"; else fff_write "$FFF_ROOT/config/config.json" <"$here/config.vm.example.json"; fi
  log "written from config.vm.example.json; set ownerName (docs, 'Installing')"
fi
url_changed=0
if sync_public_url; then url_changed=1; fi

log "9/10 the orchestration worker (w597, docs/ops-worker.md): account $OPS_USER, ${OPS_DISK_MB} MB scratch, fff-ops.socket"
# Its own account: no password, no ssh login (sshd's AllowUsers names the admin alone), a home on its scratch.
if ! id "$OPS_USER" >/dev/null 2>&1; then
  run_cmd useradd --system --user-group --home-dir "$OPS_ROOT/home" --no-create-home --shell /bin/bash --comment 'FF Factory orchestration worker (w597)' "$OPS_USER"
fi
run_cmd passwd -l "$OPS_USER" >/dev/null
# The disk cap: everything it can write (its home, Claude Code's files, its scratch and temp) is one ext4 file system in
# a file of OPS_DISK_MB, mounted nosuid,nodev,noexec. Full is full: nothing it writes reaches the VM's own disk.
run_cmd install -d -m 0700 -o root -g root "$(dirname "$OPS_IMAGE")"
if [ ! -f "$OPS_IMAGE" ]; then
  run_cmd fallocate -l "${OPS_DISK_MB}M" "$OPS_IMAGE"
  run_cmd chmod 0600 "$OPS_IMAGE"
  run_cmd mkfs.ext4 -q -F -m 0 -L fff-ops "$OPS_IMAGE"
elif [ "$DRY_RUN" != 1 ]; then
  have_mb=$(($(stat -c %s "$OPS_IMAGE") / 1048576))
  [ "$have_mb" -eq "$OPS_DISK_MB" ] || warn "the orchestration worker's scratch is $have_mb MB, not OPS_DISK_MB=$OPS_DISK_MB: docs/ops-worker.md says how to resize it"
fi
# Rendered from units/*.in (render_unit, lib.sh), so deploy/vm/test/fff-units.test.sh can lint what is installed.
c=$(render_unit "$here/units/fff-ops-scratch.service.in" OPS_DISK_MB OPS_ROOT OPS_IMAGE OPS_USER "OPS_IMAGE_DIR=$(dirname "$OPS_IMAGE")" "OPS_ROOT_PARENT=$(dirname "$OPS_ROOT")" | write_file /etc/systemd/system/fff-ops-scratch.service 0644)
# The network it may reach: Anthropic's API, the tailnet (the machines, MagicDNS), loopback and this VM's resolvers.
resolvers=$(awk '$1 == "nameserver" {print $2}' /etc/resolv.conf 2>/dev/null | paste -sd' ' - || true)
c+=$(render_unit "$here/units/fff-ops@.service.in" OPS_USER FFF_LIB OPS_ROOT FFF_ROOT OPS_ALLOW_NETS "RESOLVERS=$resolvers" OPS_MEMORY_MAX OPS_RUNTIME_MAX | write_file /etc/systemd/system/fff-ops@.service 0644)
c+=$(write_file /etc/systemd/system/fff-ops.socket 0644 <"$here/units/fff-ops.socket")
# sudo: the two wrappers, and nothing else. Checked with visudo before it is put in place.
sudoers=$(mktemp)
cat >"$sudoers" <<EOF
# /etc/sudoers.d/fff-ops (deploy/vm/guest/install.sh, w597, docs/ops-worker.md): the orchestration worker's only rights.
# Its fffctl and fff-machine-ssh: status, state, logs, machine-ssh, credential list and issue (fff-ops-priv decides).
$OPS_USER ALL=(root) NOPASSWD: $FFF_LIB/fff-ops-priv
# Its ssh, as the portal's account with the portal's key, fixed options (fff-ops-ssh).
$OPS_USER ALL=($FFF_USER) NOPASSWD: $FFF_LIB/fff-ops-ssh
Defaults:$OPS_USER !lecture, env_reset, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EOF
visudo -cqf "$sudoers" || die "the orchestration worker's sudoers does not parse (visudo -cf)"
c+=$(write_file /etc/sudoers.d/fff-ops 0440 <"$sudoers")
rm -f "$sudoers"
[ -z "$c" ] || run_cmd systemctl daemon-reload
run_cmd systemctl enable fff-ops-scratch.service fff-ops.socket
run_cmd systemctl start fff-ops-scratch.service
if [ "$DRY_RUN" != 1 ]; then
  findmnt -n -o OPTIONS "$OPS_ROOT" | matches noexec || die "$OPS_ROOT is not the worker's noexec scratch file system"
fi
# Only when something of it changed: a restart would cut the worker's own connection, and an update the worker asked
# for runs this script too.
if [ -n "$c" ] || ! systemctl is-active --quiet fff-ops.socket; then run_cmd systemctl restart fff-ops.socket; fi
# Its Claude Code: the portal's own Agent SDK binary (fff-portal.service runs this again at each start).
run_cmd "$FFF_LIB/fff-ops-sync" || warn "fff-ops-sync failed: the orchestration worker cannot start until the portal's next start copies its Claude Code"

log "9/10 (b) the portal's agents (w5598, docs/vault.md \"In the VM\"): account $AGENT_USER, fff-agent.socket"
# Never fatal: whatever fails here, the portal starts its agents as $FFF_USER, as before, and alerts its owners
# (server/agentAccount.ts). Each step says what failed; the socket is then stopped, so the portal does not try it.
agent_setup() {
  if ! id "$AGENT_USER" >/dev/null 2>&1; then
    run_cmd useradd --system --user-group --home-dir "$AGENT_ROOT/home" --no-create-home --shell /usr/sbin/nologin --comment "FF Factory's agents (w5598)" "$AGENT_USER" || return 1
  fi
  run_cmd passwd -l "$AGENT_USER" >/dev/null || return 1
  run_cmd install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_ROOT" "$AGENT_ROOT/home" || return 1
  local u=""
  u+=$(render_unit "$here/units/fff-agent-views.service.in" FFF_ROOT FFF_LIB | write_file /etc/systemd/system/fff-agent-views.service 0644) || return 1
  u+=$(render_unit "$here/units/fff-agent@.service.in" AGENT_USER AGENT_ROOT FFF_ROOT FFF_LIB "BASE_PATH=${BASE_PATH:-$FFF_ROOT/base}" | write_file /etc/systemd/system/fff-agent@.service 0644) || return 1
  u+=$(write_file /etc/systemd/system/fff-agent.socket 0644 <"$here/units/fff-agent.socket") || return 1
  [ -z "$u" ] || run_cmd systemctl daemon-reload || return 1
  run_cmd systemctl enable fff-agent-views.service || return 1
  # Only when it changed or is not up. A restart of the views stops the running agents with them (fff-agent@ Requires=
  # them); step 10 restarts the portal after a change anyway, which stops them too (fff-portal.service, w5651).
  if [ -n "$u" ] || ! systemctl is-active --quiet fff-agent-views.service; then run_cmd systemctl restart fff-agent-views.service || return 1; fi
  if [ "$(cat "$FFF_AGENT_SWITCH" 2>/dev/null)" = off ]; then
    # fffctl agents off (w5651): a person or the ops worker switched it off; it stays off until fffctl agents warn or on.
    log "  fffctl agents off ($FFF_AGENT_SWITCH): fff-agent.socket stays stopped"
    run_cmd systemctl disable --now fff-agent.socket 2>/dev/null || true
  else
    run_cmd systemctl enable fff-agent.socket || return 1
    if [ -n "$u" ] || ! systemctl is-active --quiet fff-agent.socket; then run_cmd systemctl restart fff-agent.socket || return 1; fi
  fi
  if [ "$DRY_RUN" != 1 ]; then "$FFF_LIB/fff-agent-views" check || return 1; fi
}
if ! agent_setup; then
  warn "the portal's agents' own account is not set up (above): they start as $FFF_USER, and the portal alerts its owners"
  journalctl -u fff-agent-views.service -n 20 --no-pager -o cat 2>/dev/null | sed 's/^/  fff-agent-views: /' >&2 || true
  run_cmd systemctl disable --now fff-agent.socket 2>/dev/null || true
fi

log "10/10 systemd units"
c=""
for u in fff-portal.service fff-health.service fff-health.timer fff-update.path fff-update.service fff-backup.service fff-base-refresh.service fff-base-refresh.timer; do
  c+=$(write_file "/etc/systemd/system/$u" 0644 <"$here/units/$u")
done
c+=$(render_unit "$here/units/fff-backup.timer.in" BACKUP_TIME | write_file /etc/systemd/system/fff-backup.timer 0644)
# The server reads its own journal for portal_logs (w920): the systemd-journal group, for that service only. Not written
# where the group is missing (a unit naming a missing group does not start).
if getent group systemd-journal >/dev/null; then
  c+=$(write_file /etc/systemd/system/fff-portal.service.d/20-journal.conf 0644 <"$here/units/fff-portal-journal.conf")
fi
# Tailscale's own unit gives up after 5 starts in 10 s; the portal is unreachable without it (w698).
c+=$(write_file /etc/systemd/system/tailscaled.service.d/10-fff-restart.conf 0644 <"$here/units/tailscaled-restart.conf")
[ -z "$c" ] || run_cmd systemctl daemon-reload
run_cmd systemctl enable fff-portal.service fff-health.timer fff-update.path fff-backup.timer fff-base-refresh.timer
# Every critical unit starts at boot (w698): enable is idempotent, and a unit that stays disabled is one that does not come
# back after a reboot (the unit list is FFF_CRITICAL_UNITS in lib.sh, which fff-watchdog and deploy/vm/test/fff-units.test.sh
# read too). tailscaled is the package's unit: its postinst enables it, but this does not rely on that.
run_cmd systemctl enable "${FFF_CRITICAL_UNITS[@]}"
# Tailscale's own auto-update off (w2474), on a node fffctl tailscale-join set it on: the nightly restart upgrades it
# (fffctl prepare-shutdown). Only while it is not off already, so an update does not touch tailscaled's prefs again.
if [ "$DRY_RUN" != 1 ] && tailscale debug prefs 2>/dev/null | jq -e '.AutoUpdate.Apply != false' >/dev/null 2>&1; then
  run_cmd tailscale set --auto-update=false || warn "tailscale set --auto-update=false failed (exit $?); Tailscale may still update itself in the day"
fi
if [ "$DRY_RUN" != 1 ]; then
  for u in "${FFF_CRITICAL_UNITS[@]}"; do
    enable_state_ok "$(systemctl is-enabled "$u" 2>/dev/null || true)" ||
      die "$u is not enabled ($(systemctl is-enabled "$u" 2>&1 || true)) after systemctl enable: it would not start after a reboot"
  done
  log "enabled at boot: ${FFF_CRITICAL_UNITS[*]}"
fi
if [ "$START" = 1 ]; then
  run_cmd systemctl start fff-update.path fff-health.timer fff-backup.timer fff-base-refresh.timer
  if { [ -n "$c" ] || [ "$url_changed" = 1 ]; } && portal_active; then
    log "$([ -n "$c" ] && echo "units changed" || echo "publicUrl changed"): restarting the portal with a drain"
    run_cmd /usr/local/sbin/fffctl restart --drain-minutes 5
  else
    run_cmd systemctl start fff-portal.service
  fi
  if [ "$DRY_RUN" != 1 ]; then
    for _ in $(seq 120); do health_json >/dev/null 2>&1 && break; sleep 1; done
    health_json >/dev/null 2>&1 || die "the portal does not answer http://127.0.0.1:$FFF_PORT/api/health after 2 minutes: fffctl logs"
    log "the portal answers: $(health_json)"
  fi
fi

[ "$TODO" = 1 ] && cat >&2 <<EOF

Installed. Still to do, by a person (docs/portal-on-ffbox-host.md, "Installing"):
  1. sudo fffctl vault add-claude PERSON                          each person's Claude tokens: every Claude process runs on one (w1078)
  2. sudo fffctl tailscale-join --authkey-file /root/ts.key       tagged node, Funnel to the portal
  3. sudo fffctl gh-login --token-file /root/gh.token             the portal's GitHub token (D7)
  4. sudo fffctl base-clone                                       the game repo for orchestrators' reads
  5. sudo fffctl configure --owner-name NAME                      config.json's ownerName (publicUrl: set from Tailscale)
  6. backups: age public keys in $BACKUP_RECIPIENTS_FILE, BACKUP_SSH_TARGET in $FFF_CONF,
     and authorize $BACKUP_SSH_KEY.pub there; then sudo fffctl backup
  The portal's ssh key for machine deploys: $FFF_ROOT/home/.ssh/id_ed25519.pub (authorize with from=, docs 4.3).
EOF
[ "$DRY_RUN" != 1 ] || log "DRY RUN finished: nothing was changed"
