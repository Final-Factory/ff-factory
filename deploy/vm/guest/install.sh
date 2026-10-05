#!/usr/bin/env bash
# Install the FF Factory portal inside its VM (docs/portal-on-ffbox-host.md, "Installing"). Run as root in the VM:
#
#   git clone https://github.com/Final-Factory/ff-factory.git && sudo ff-factory/deploy/vm/guest/install.sh [--dry-run]
#   options: --repo URL (default FFF_REPO_URL)  --ref REF (default origin/<FFF_BRANCH>)  --no-start
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
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --repo) REPO_URL=$2; shift ;;
    --ref) REF=$2; shift ;;
    --no-start) START=0 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
need_root
load_conf
[ -z "$REPO_URL" ] || FFF_REPO_URL=$REPO_URL
[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing will be changed"

log "1/9 preflight"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu only (this is ${PRETTY_NAME:-unknown})"
[ -d /run/systemd/system ] || die "systemd is not running"
log "guest: $PRETTY_NAME, $(nproc) vCPUs, $(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo), $(df -h --output=avail / | tail -n 1 | xargs) free on /"
[ -f /etc/fff-vm-guest.env ] || warn "no /etc/fff-vm-guest.env (made by the host's cloud-init): not the portal VM? The firewall gets no rule for the host's health check"
curl -fsS -m 15 -o /dev/null "https://deb.nodesource.com/node_$NODE_MAJOR.x/dists/nodistro/Release" || die "no route to the internet (deb.nodesource.com)"

log "2/9 apt sources: NodeSource node_$NODE_MAJOR.x, GitHub CLI, Tailscale"
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

log "3/9 packages"
pkgs=(nodejs git git-lfs gh openssh-client openssh-server tailscale age rsync jq curl ca-certificates nftables util-linux unattended-upgrades)
missing=()
for p in "${pkgs[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p"); done
if [ -n "$c" ] || [ ${#missing[@]} -gt 0 ]; then run_cmd env DEBIAN_FRONTEND=noninteractive apt-get update -q; fi
if [ ${#missing[@]} -gt 0 ]; then run_cmd env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"; fi
if [ "$DRY_RUN" != 1 ]; then
  have=$(node -p 'process.versions.node.split(".")[0]')
  [ "$have" = "$NODE_MAJOR" ] || die "node is $have, not $NODE_MAJOR (another nodejs package won?)"
  log "node $(node --version), npm $(npm --version), git $(git --version | cut -d' ' -f3), gh $(gh --version | head -n 1 | cut -d' ' -f3), tailscale $(tailscale version | head -n 1)"
fi

log "4/9 the fff account and $FFF_ROOT"
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
if [ -n "$REPO_URL" ] && ! grep -qxF "FFF_REPO_URL=$REPO_URL" "$FFF_CONF" 2>/dev/null; then
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would set FFF_REPO_URL=$REPO_URL in $FFF_CONF"; else
    sed -i '/^FFF_REPO_URL=/d' "$FFF_CONF"
    echo "FFF_REPO_URL=$REPO_URL" >>"$FFF_CONF"
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

log "5/9 the VM's own firewall (table inet fff_guest)"
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
# Ubuntu 24.04 starts sshd from ssh.socket: reload it only if it runs (a new one reads the file anyway).
if [ -n "$sshd" ]; then run_cmd sshd -t && run_cmd systemctl try-reload-or-restart ssh.service; fi

log "6/9 scripts: fffctl, fff-update, fff-health, fff-backup, fff-base-refresh"
run_cmd install -d -m 0755 /usr/local/lib/fff
for f in lib.sh fff.conf.example config.vm.example.json; do write_file "/usr/local/lib/fff/$f" 0644 <"$here/$f" >/dev/null; done
for f in fff-update fff-health fff-backup fff-base-refresh; do write_file "/usr/local/lib/fff/$f" 0755 <"$here/$f" >/dev/null; done
write_file /usr/local/sbin/fffctl 0755 <"$here/fffctl" >/dev/null

log "7/9 ff-factory: the first release (fff-update init)"
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

log "8/9 config.json"
if [ -f "$FFF_ROOT/config/config.json" ]; then
  log "kept: $FFF_ROOT/config/config.json"
else
  write_file "$FFF_ROOT/config/config.json" 0600 "$FFF_USER:$FFF_USER" <"$here/config.vm.example.json" >/dev/null
  log "written from config.vm.example.json; set ownerName and publicUrl (docs, 'Installing')"
fi

log "9/9 systemd units"
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
  if [ -n "$c" ] && portal_active; then
    log "units changed: restarting the portal with a drain"
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

cat >&2 <<EOF

Installed. Still to do, by a person (docs/portal-on-ffbox-host.md, "Installing"):
  1. sudo fffctl claude-token --file /root/claude.token          Lothsahn's subscription token (D4, 'claude setup-token')
  2. sudo fffctl tailscale-join --authkey-file /root/ts.key       tagged node, Funnel to the portal
  3. sudo fffctl gh-login --token-file /root/gh.token             the portal's GitHub token (D7)
  4. sudo fffctl base-clone                                       the game repo for orchestrators' reads
  5. $FFF_ROOT/config/config.json: ownerName, publicUrl, claudeAccounts; then sudo fffctl restart
  6. backups: age public keys in $BACKUP_RECIPIENTS_FILE, BACKUP_SSH_TARGET in $FFF_CONF,
     and authorize $BACKUP_SSH_KEY.pub there; then sudo fffctl backup
  The portal's ssh key for machine deploys: $FFF_ROOT/home/.ssh/id_ed25519.pub (authorize with from=, docs 4.3).
EOF
[ "$DRY_RUN" != 1 ] || log "DRY RUN finished: nothing was changed"
