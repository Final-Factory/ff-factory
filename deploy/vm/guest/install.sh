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
key() { # URL DEST [dearmor]
  [ -s "$2" ] && return 0
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would fetch the key $1 to $2"; return 0; fi
  install -d -m 0755 "$(dirname "$2")"
  if [ "${3:-}" = dearmor ]; then curl -fsSL "$1" | gpg --dearmor -o "$2"; else curl -fsSL -o "$2" "$1"; fi
  chmod 0644 "$2"
}
key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /etc/apt/keyrings/nodesource.gpg dearmor
key https://cli.github.com/packages/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
key "https://pkgs.tailscale.com/stable/ubuntu/$codename.noarmor.gpg" /usr/share/keyrings/tailscale-archive-keyring.gpg
c=""
c+=$(echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | write_file /etc/apt/sources.list.d/nodesource.list 0644)
c+=$(printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' | write_file /etc/apt/preferences.d/nodesource 0644)
c+=$(echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | write_file /etc/apt/sources.list.d/github-cli.list 0644)
c+=$(echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu $codename main" | write_file /etc/apt/sources.list.d/tailscale.list 0644)
# Security updates for these too, not only Ubuntu's (unattended-upgrades' "site=" pattern).
write_file /etc/apt/apt.conf.d/53fff-third-party 0644 >/dev/null <<'EOF'
// deploy/vm/guest: unattended-upgrades also takes Node (within its major version), gh and Tailscale.
Unattended-Upgrade::Origins-Pattern {
  "site=deb.nodesource.com";
  "site=cli.github.com";
  "site=pkgs.tailscale.com";
};
EOF

log "3/10 packages"
# zstd and bzip2: fffctl migrate unpacks BEAST's copy with them (w517).
# e2fsprogs: the orchestration worker's scratch file system (w597).
pkgs=(nodejs git git-lfs gh openssh-client openssh-server tailscale age rsync jq curl ca-certificates nftables util-linux unattended-upgrades zstd bzip2 e2fsprogs)
missing=()
for p in "${pkgs[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | matches 'install ok installed' || missing+=("$p"); done
if [ -n "$c" ] || [ ${#missing[@]} -gt 0 ]; then run_cmd env DEBIAN_FRONTEND=noninteractive apt-get update -q; fi
if [ ${#missing[@]} -gt 0 ]; then run_cmd env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"; fi
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
for d in "" /home /config /data /app /agents /review /sandboxes /secrets; do
  run_cmd install -d -m 0700 -o "$FFF_USER" -g "$FFF_USER" "$FFF_ROOT$d"
done
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
  run_cmd install -d -m 0700 -o "$FFF_USER" -g "$FFF_USER" "$FFF_ROOT/home/.ssh"
  [ "$DRY_RUN" = 1 ] || as_fff ssh-keygen -q -t ed25519 -N '' -C "fff-portal@$(hostname -s)" -f "$FFF_ROOT/home/.ssh/id_ed25519"
fi
# The server reads Max's Discord token from here (server/discordConfig.ts): the portal's own copy, never FFBox's.
run_cmd install -d -m 0700 -o "$FFF_USER" -g "$FFF_USER" "$FFF_ROOT/home/.config" "$FFF_ROOT/home/.config/ffbox"

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
    iifname "tailscale0" tcp dport 443 accept comment "Funnel and tailnet HTTPS (tailscale serve) to the portal"
    iifname "tailscale0" tcp dport 22 accept comment "ssh from the tailnet only: the tailnet policy says who; Funnel never carries 22"
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
  as_fff bash -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash' || warn "the Claude Code CLI did not install; fffctl claude-login needs it (rerun install.sh)"
fi

log "8/10 config.json"
if [ -f "$FFF_ROOT/config/config.json" ]; then
  log "kept: $FFF_ROOT/config/config.json"
else
  write_file "$FFF_ROOT/config/config.json" 0600 "$FFF_USER:$FFF_USER" <"$here/config.vm.example.json" >/dev/null
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
c=$(write_file /etc/systemd/system/fff-ops-scratch.service 0644 <<EOF
[Unit]
Description=FF Factory orchestration worker: its ${OPS_DISK_MB} MB scratch file system (w597)
Documentation=https://github.com/Final-Factory/ff-factory/blob/main/docs/ops-worker.md
RequiresMountsFor=$(dirname "$OPS_IMAGE") $(dirname "$OPS_ROOT")

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/usr/bin/install -d -m 0755 $OPS_ROOT
ExecStart=/bin/sh -c 'mountpoint -q $OPS_ROOT || mount -o loop,nosuid,nodev,noexec $OPS_IMAGE $OPS_ROOT'
ExecStartPost=/bin/sh -c 'chown root:$OPS_USER $OPS_ROOT && chmod 0750 $OPS_ROOT && install -d -m 0700 -o $OPS_USER -g $OPS_USER $OPS_ROOT/home $OPS_ROOT/scratch $OPS_ROOT/tmp'
ExecStop=/bin/umount $OPS_ROOT

[Install]
WantedBy=multi-user.target
EOF
)
# The network it may reach: Anthropic's API, the tailnet (the machines, MagicDNS), loopback and this VM's resolvers.
resolvers=$(awk '$1 == "nameserver" {print $2}' /etc/resolv.conf 2>/dev/null | paste -sd' ' - || true)
c+=$(write_file /etc/systemd/system/fff-ops@.service 0644 <<EOF
[Unit]
Description=FF Factory orchestration worker: Claude Code as $OPS_USER for the portal (w597)
Documentation=https://github.com/Final-Factory/ff-factory/blob/main/docs/ops-worker.md
Requires=fff-ops-scratch.service
After=fff-ops-scratch.service network-online.target

[Service]
Type=simple
User=$OPS_USER
Group=$OPS_USER
# One connection to fff-ops.socket: the portal's header, then Claude Code's stream on the same socket.
ExecStart=$FFF_LIB/fff-ops-launch
StandardInput=socket
StandardOutput=socket
StandardError=journal
SyslogIdentifier=fff-ops
WorkingDirectory=$OPS_ROOT
UMask=0077
# sudo runs its two wrappers (/etc/sudoers.d/fff-ops), so no NoNewPrivileges, nor any setting that implies it.
NoNewPrivileges=no
# The whole file system read-only but its scratch; /srv/fff stays writable only for what sudo runs as root or fff there
# (a machine credential): fff-ops itself cannot enter it (0700 fff). /tmp, /var/tmp and /dev/shm are small and its own.
ProtectSystem=strict
ProtectHome=tmpfs
ReadWritePaths=$OPS_ROOT $FFF_ROOT -/run/fff -/var/lib/sudo
# /run/sudo: sudo's own time stamps, on a private tmpfs (/run is read-only here).
TemporaryFileSystem=/tmp:size=64M,mode=1777 /var/tmp:size=16M,mode=1777 /dev/shm:size=16M,mode=1777 /run/sudo:size=1M,mode=0711
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8 ::1/128 $OPS_ALLOW_NETS $resolvers
MemoryMax=$OPS_MEMORY_MAX
TasksMax=256
CPUWeight=50
# Its lifetime's backstop: the portal stops an idle process after 1 h and cuts a turn after 2 h.
RuntimeMaxSec=$OPS_RUNTIME_MAX
EOF
)
c+=$(write_file /etc/systemd/system/fff-ops.socket 0644 <"$here/units/fff-ops.socket")
# sudo: the two wrappers, and nothing else. Checked with visudo before it is put in place.
sudoers=$(mktemp)
cat >"$sudoers" <<EOF
# /etc/sudoers.d/fff-ops (deploy/vm/guest/install.sh, w597, docs/ops-worker.md): the orchestration worker's only rights.
# Its fffctl: status, state, logs, machine-ssh-check, credential list and issue (fff-ops-priv decides).
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

log "10/10 systemd units"
c=""
for u in fff-portal.service fff-health.service fff-health.timer fff-update.path fff-update.service fff-backup.service fff-base-refresh.service fff-base-refresh.timer; do
  c+=$(write_file "/etc/systemd/system/$u" 0644 <"$here/units/$u")
done
c+=$(write_file /etc/systemd/system/fff-backup.timer 0644 <<EOF
[Unit]
Description=FF Factory portal: encrypted backup every day at $BACKUP_TIME UTC

[Timer]
OnCalendar=*-*-* $BACKUP_TIME:00 UTC
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF
)
[ -z "$c" ] || run_cmd systemctl daemon-reload
run_cmd systemctl enable fff-portal.service fff-health.timer fff-update.path fff-backup.timer fff-base-refresh.timer
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
  1. sudo fffctl claude-token --file /root/claude.token          Lothsahn's subscription token (D4, 'claude setup-token')
  2. sudo fffctl tailscale-join --authkey-file /root/ts.key       tagged node, Funnel to the portal
  3. sudo fffctl gh-login --token-file /root/gh.token             the portal's GitHub token (D7)
  4. sudo fffctl base-clone                                       the game repo for orchestrators' reads
  5. $FFF_ROOT/config/config.json: ownerName, claudeAccounts; then sudo fffctl restart (publicUrl: set from Tailscale)
  6. backups: age public keys in $BACKUP_RECIPIENTS_FILE, BACKUP_SSH_TARGET in $FFF_CONF,
     and authorize $BACKUP_SSH_KEY.pub there; then sudo fffctl backup
  The portal's ssh key for machine deploys: $FFF_ROOT/home/.ssh/id_ed25519.pub (authorize with from=, docs 4.3).
EOF
[ "$DRY_RUN" != 1 ] || log "DRY RUN finished: nothing was changed"
