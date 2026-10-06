# shellcheck shell=bash
# The installer's questions (deploy/vm/host/install.sh, w498). Sourced, never run.
#
# Every answer is stored on the host, so a re-run, or a rebuilt VM, asks nothing it already knows:
#   /etc/fff-vm/fff-vm.conf             the settings (shell, KEY=value lines this file adds or replaces)
#   /etc/fff-vm/admin_authorized_keys   the admin's ssh public key(s)
#   /etc/fff-vm/ntfy-url                the alerts' ntfy URL (0600)
#   /etc/fff-vm/backup-recipients.txt   the backups' age public keys
#   /etc/fff-vm/secrets/                claude-token, tailscale-authkey, gh-token: 0600 in a 0700 folder, root's;
#                                       people/<user id>/{claude,github}-token and vault.key: the token vault (vault.sh)
# A secret is read without echo, never put on a command line, in a log or in the cloud-init seed, and goes into the VM
# only over ssh's stdin (guest.sh). Root on this host can read the VM anyway (design D2): this copy changes no boundary.
#
# Interactive (a terminal, no --yes): it asks for what is missing, with the default in brackets, and asks again until
# the answer is valid. Non-interactive (--yes, or no terminal): it takes what is stored, and when a required answer is
# missing or malformed it stops before anything is changed, naming each one and how to provide it.

SECRETS=$FFF_VM_ETC/secrets
RECIPIENTS_FILE=$FFF_VM_ETC/backup-recipients.txt
# A Tailscale auth key made for this install expires after a day (RUNBOOK, section 1); older stored keys are not used.
TS_KEY_MAX_AGE_H=24
MISSING=()

interactive() { [ "${INTERACTIVE:-0}" = 1 ]; }

# Validators: each returns 0 for a good answer, else prints why on stdout and returns 1.
v_nonempty() { [ -n "$1" ] || { echo "empty"; return 1; }; }
v_tz() { [ -n "$1" ] && [ -f "/usr/share/zoneinfo/$1" ] && [ "${1#*..}" = "$1" ] || { echo "not a time zone in /usr/share/zoneinfo (e.g. America/Denver)"; return 1; }; }
v_url() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || { echo "not an https:// URL"; return 1; }; }
v_sshkey() {
  [[ "$1" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\ [A-Za-z0-9+/=]+ ]] || { echo "not an OpenSSH public key (ssh-ed25519 AAAA...)"; return 1; }
  ssh-keygen -l -f - <<<"$1" >/dev/null 2>&1 || { echo "ssh-keygen cannot read it as a public key"; return 1; }
}
v_claude() { [[ "$1" =~ ^sk-ant-oat01-[A-Za-z0-9_-]{20,}$ ]] || { echo "not a 'claude setup-token' token (sk-ant-oat01-...)"; return 1; }; }
v_tskey() { [[ "$1" =~ ^tskey-auth-[A-Za-z0-9_-]{10,}$ ]] || { echo "not a Tailscale auth key (tskey-auth-...)"; return 1; }; }
v_ghtoken() { [[ "$1" =~ ^(github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,})$ ]] || { echo "not a GitHub token (github_pat_... or ghp_...)"; return 1; }; }
v_owner() { [[ "$1" =~ ^[A-Za-z][A-Za-z0-9\ ._-]{0,39}$ ]] || { echo "a name of 1-40 letters, digits, spaces, . _ -"; return 1; }; }
v_dataset() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*(/[A-Za-z0-9_.:-]+)+$ ]] || { echo "a dataset under a pool, e.g. tank/fff-vm"; return 1; }
  zpool list -H -o name "${1%%/*}" >/dev/null 2>&1 || { echo "no ZFS pool '${1%%/*}' (zpool list: $(zpool list -H -o name 2>/dev/null | tr '\n' ' '))"; return 1; }
}
v_mountpoint() { [[ "$1" =~ ^(/[A-Za-z0-9._-]+)+$|^none$ ]] || { echo "an absolute folder (e.g. /tank/fff-vm), or none"; return 1; }; }
v_target() { [ -z "$1" ] || [[ "$1" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] || { echo "user@host (e.g. fff-backup@beast), or empty for no backups"; return 1; }; }
v_agekeys() {
  local k n=0
  for k in $1; do [[ "$k" =~ ^age1[0-9a-z]{58}$ ]] || { echo "'${k:0:12}...' is not an age public key (age1...)"; return 1; }; n=$((n + 1)); done
  [ "$n" -gt 0 ] || { echo "no key"; return 1; }
}

# ask VAR VALIDATOR QUESTION [DEFAULT]: interactive only; sets VAR to a valid answer (the default on Enter).
ask() {
  local var=$1 check=$2 q=$3 def=${4:-} ans why
  while :; do
    printf '%s%s: ' "$q" "${def:+ [$def]}" >/dev/tty
    IFS= read -r ans </dev/tty || die "no answer (end of input): stopped before changing anything"
    ans=${ans:-$def}
    if why=$("$check" "$ans"); then printf -v "$var" '%s' "$ans"; return 0; fi
    printf '  %s; again (Ctrl-C stops)\n' "$why" >/dev/tty
  done
}

# ask_secret FILE VALIDATOR QUESTION: interactive only; reads without echo and stores it in $SECRETS/FILE.
ask_secret() {
  local file=$1 check=$2 q=$3 ans why
  while :; do
    printf '%s (typing is not shown): ' "$q" >/dev/tty
    IFS= read -rs ans </dev/tty || die "no answer (end of input): stopped before changing anything"
    printf '\n' >/dev/tty
    ans=$(printf '%s' "$ans" | tr -d '[:space:]')
    if why=$("$check" "$ans"); then printf '%s\n' "$ans" | secret_put "$file"; return 0; fi
    printf '  %s; again (Ctrl-C stops)\n' "$why" >/dev/tty
  done
}

# yes_no QUESTION DEFAULT(y|n): interactive only.
yes_no() {
  local ans
  while :; do
    printf '%s [%s]: ' "$1" "$([ "$2" = y ] && echo Y/n || echo y/N)" >/dev/tty
    IFS= read -r ans </dev/tty || die "no answer (end of input): stopped before changing anything"
    case "${ans:-$2}" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; esac
  done
}

missing() { MISSING+=("$1"); }

# secret_put NAME: stdin into $SECRETS/NAME, root's, 0600. Its value is never printed; a dry run stores it nowhere.
secret_put() {
  local tmp
  if [ "$DRY_RUN" = 1 ]; then cat >/dev/null; log "DRY-RUN would store the answer in $SECRETS/$1 (0600)"; return 0; fi
  install -d -m 0700 -o root -g root "$SECRETS"
  tmp=$(mktemp "$SECRETS/.$1.XXXXXX")
  cat >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$SECRETS/$1"
}
secret_ok() { [ -s "$SECRETS/$1" ] && "$2" "$(head -n 1 "$SECRETS/$1")" >/dev/null; }
# The stored Tailscale key, if it is younger than TS_KEY_MAX_AGE_H (a stored key older than that has expired).
ts_key_fresh() { secret_ok tailscale-authkey v_tskey && [ -n "$(find "$SECRETS/tailscale-authkey" -mmin -$((TS_KEY_MAX_AGE_H * 60)) 2>/dev/null)" ]; }

# conf_set KEY VALUE: the answer now (the variable), and in the settings file once every answer is in (answers_commit).
PENDING=()
conf_set() { printf -v "$1" '%s' "$2"; PENDING+=("$1"); }
# answers_commit: write the answers into the settings file, replacing KEY=... or adding it (shell-quoted).
answers_commit() {
  local k tmp
  [ ${#PENDING[@]} -gt 0 ] || return 0
  for k in "${PENDING[@]}"; do
    if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would set $k in $CONF"; continue; fi
    install -d -m 0755 "$(dirname "$CONF")"
    tmp=$(mktemp)
    { [ ! -f "$CONF" ] || grep -v "^$k=" "$CONF" || true; printf '%s=%q\n' "$k" "${!k}"; } >"$tmp"
    install -m 0644 -o root -g root "$tmp" "$CONF"
    rm -f "$tmp"
  done
  PENDING=()
}
conf_has() { [ -f "$CONF" ] && grep -q "^$1=" "$CONF"; }

# ---------------------------------------------------------------- the host's answers
answers_host() {
  local pools first def mp
  # The disk: a ZFS volume under a dataset of its own (or VM_DISK_MODE=qcow2, set by hand).
  if [ "$VM_DISK_MODE" = zvol ]; then
    if [ -z "$VM_ZVOL_PARENT" ] || ! v_dataset "$VM_ZVOL_PARENT" >/dev/null; then
      if interactive; then
        pools=$(zpool list -H -o name,free 2>/dev/null | awk '{printf "%s (%s free)  ", $1, $2}')
        first=$(zpool list -H -o name 2>/dev/null | head -n 1)
        [ -n "$first" ] || die "no ZFS pool on this host (zpool list): make one, or set VM_DISK_MODE=qcow2 in $CONF"
        printf 'ZFS pools: %s\n' "$pools" >/dev/tty
        ask VM_ZVOL_PARENT v_dataset "The VM's dataset (its disk is a volume inside it)" "$first/fff-vm"
        conf_set VM_ZVOL_PARENT "$VM_ZVOL_PARENT"
      else missing "VM_ZVOL_PARENT in $CONF: the VM's dataset on a pool from 'zpool list', e.g. tank/fff-vm (or VM_DISK_MODE=qcow2)"; fi
    fi
    if [ -z "${VM_ZFS_MOUNTPOINT:-}" ] || ! v_mountpoint "$VM_ZFS_MOUNTPOINT" >/dev/null; then
      # An existing dataset keeps its mountpoint as the default; a new one gets ZFS's own (/<dataset>).
      mp=$(zfs get -H -o value mountpoint "$VM_ZVOL_PARENT" 2>/dev/null || true)
      def=${mp:-/$VM_ZVOL_PARENT}
      if interactive; then
        ask VM_ZFS_MOUNTPOINT v_mountpoint "Where that dataset is mounted (the VM's disk is a volume, so nothing is written there)" "$def"
        conf_set VM_ZFS_MOUNTPOINT "$VM_ZFS_MOUNTPOINT"
      elif [ -n "$VM_ZVOL_PARENT" ]; then
        conf_set VM_ZFS_MOUNTPOINT "$def"
        log "VM_ZFS_MOUNTPOINT: $def (the default; set it in $CONF to change it)"
      fi
    fi
  fi
  if ! conf_has VM_TIMEZONE || ! v_tz "$VM_TIMEZONE" >/dev/null; then
    if interactive; then
      ask VM_TIMEZONE v_tz "The VM's time zone (the portal's schedules run in it)" America/Denver
      conf_set VM_TIMEZONE "$VM_TIMEZONE"
    else missing "VM_TIMEZONE in $CONF: a zone from /usr/share/zoneinfo, e.g. America/Denver"; fi
  fi
  if ! grep -Eq '^(ssh-|ecdsa-|sk-)' "$VM_ADMIN_KEYS_FILE" 2>/dev/null; then
    if interactive; then
      local who home key
      who=${SUDO_USER:-root}
      home=$(getent passwd "$who" | cut -d: -f6)
      key=$(head -n 1 "$home/.ssh/id_ed25519.pub" 2>/dev/null || true)
      [ -z "$key" ] || printf 'Found %s\n' "$home/.ssh/id_ed25519.pub" >/dev/tty
      ask key v_sshkey "Your ssh public key for the VM's admin account (paste one line)" "$key"
      if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would write $VM_ADMIN_KEYS_FILE"; else
        install -d -m 0755 "$FFF_VM_ETC"
        printf '%s\n' "$key" | install -m 0644 -o root -g root /dev/stdin "$VM_ADMIN_KEYS_FILE"
      fi
    else missing "$VM_ADMIN_KEYS_FILE: your ssh public key (one line, ssh-ed25519 AAAA...)"; fi
  fi
  if [ ! -s "$NTFY_URL_FILE" ] || ! v_url "$(head -n 1 "$NTFY_URL_FILE")" >/dev/null; then
    if interactive; then
      local url
      ask url v_url "The alerts' ntfy URL" https://ntfy.sh/ffsb-blp7kredyzsmubyz6fzw
      if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would write $NTFY_URL_FILE (0600)"; else
        install -d -m 0755 "$FFF_VM_ETC"
        printf '%s\n' "$url" | install -m 0600 -o root -g root /dev/stdin "$NTFY_URL_FILE"
      fi
    else missing "$NTFY_URL_FILE: the ntfy URL for alerts, one line, chmod 600"; fi
  fi
}

# ---------------------------------------------------------------- the guest's answers
# $1: what the guest has already (fffctl state as JSON, or {} before the guest install).
answers_guest() {
  local st=$1
  has() { jq -e "$1" <<<"$st" >/dev/null 2>&1; }
  if ! conf_has PORTAL_OWNER_NAME || ! v_owner "$PORTAL_OWNER_NAME" >/dev/null; then
    if has '.config.ownerName | length > 0'; then conf_set PORTAL_OWNER_NAME "$(jq -r .config.ownerName <<<"$st")"
    elif interactive; then
      ask PORTAL_OWNER_NAME v_owner "The portal's owner name (config ownerName: the person it works for)"
      conf_set PORTAL_OWNER_NAME "$PORTAL_OWNER_NAME"
    else missing "PORTAL_OWNER_NAME in $CONF: config.json's ownerName"; fi
  fi
  # 1. Lothsahn's subscription token for the orchestrators and the dispatcher (D4).
  if ! has .claudeToken && ! secret_ok claude-token v_claude; then
    if interactive; then
      printf '\nLothsahn'"'"'s Claude subscription token: run "claude setup-token" on any machine with Claude Code and copy the sk-ant-oat01-... it prints.\n' >/dev/tty
      ask_secret claude-token v_claude "Claude subscription token"
    else missing "$SECRETS/claude-token: the token from 'claude setup-token' (sk-ant-oat01-...), one line, chmod 600"; fi
  fi
  # 2. Tailscale: Ben's one-use, pre-approved, tag:fff-portal auth key. Used once, at the join, then deleted here.
  if [ "${GUEST_TAILSCALE:-join}" != skip ] && ! has .tailscale.joined && ! ts_key_fresh; then
    if interactive; then
      printf '\nThe Tailscale auth key from Ben (one-use, pre-approved, tag:fff-portal; it expires a day after he made it).\n' >/dev/tty
      printf 'It is used once, to join; the node then keeps its own identity. A rebuilt VM needs a fresh key.\n' >/dev/tty
      if [ -s "$SECRETS/tailscale-authkey" ]; then printf 'The stored key is older than %s h, so it has expired.\n' "$TS_KEY_MAX_AGE_H" >/dev/tty; fi
      ask_secret tailscale-authkey v_tskey "Tailscale auth key"
    else missing "$SECRETS/tailscale-authkey: a fresh Tailscale auth key (tskey-auth-..., younger than $TS_KEY_MAX_AGE_H h), or GUEST_TAILSCALE=skip in $CONF"; fi
  fi
  # 3. The portal's GitHub token (D7); skipped only when someone says so.
  if [ "${GUEST_GITHUB:-token}" != skip ] && ! has .github && ! secret_ok gh-token v_ghtoken; then
    if interactive; then
      printf '\nThe portal'"'"'s GitHub token (D7: a fine-grained token on the machine user). Without it the portal cannot clone the game repo.\n' >/dev/tty
      if yes_no "Do you have it now?" y; then ask_secret gh-token v_ghtoken "GitHub token"
      elif yes_no "Install without GitHub for now (fffctl gh-login and base-clone are left for later)?" n; then conf_set GUEST_GITHUB skip
      else die "stopped: run it again when you have the GitHub token"; fi
    else missing "$SECRETS/gh-token: the portal's GitHub token (github_pat_...), or GUEST_GITHUB=skip in $CONF"; fi
  fi
  # 4. Backups (D17): the age public keys and the sftp target; both may be left empty (backups off for now).
  if ! conf_has GUEST_BACKUP_SSH_TARGET; then
    if has '.backup.target | length > 0'; then conf_set GUEST_BACKUP_SSH_TARGET "$(jq -r .backup.target <<<"$st")"
    elif interactive; then
      local target keys=""
      printf '\nBackups (D17): encrypted every day with age and sent with sftp. Leave the target empty to turn them on later.\n' >/dev/tty
      ask target v_target "Backup target (user@host on the tailnet, e.g. fff-backup@beast)" ""
      if [ -n "$target" ] && ! grep -q '^age1' "$RECIPIENTS_FILE" 2>/dev/null; then
        ask keys v_agekeys "The age public keys the backups are encrypted to (age1..., space-separated; the private keys stay off this host)"
        if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would write $RECIPIENTS_FILE"; else
          tr ' ' '\n' <<<"$keys" | grep -E '^age1' | install -m 0644 -o root -g root /dev/stdin "$RECIPIENTS_FILE"
        fi
      fi
      conf_set GUEST_BACKUP_SSH_TARGET "$target"
    else conf_set GUEST_BACKUP_SSH_TARGET ""; fi
  fi
}

# Stop now, before anything is changed, when a non-interactive run lacks a required answer.
answers_check() {
  [ ${#MISSING[@]} -eq 0 ] && { answers_commit; return 0; }
  log "ERROR: missing or malformed, so nothing was changed:"
  local m
  for m in "${MISSING[@]}"; do log "  - $m"; done
  log "Run it in a terminal without --yes to be asked, or put those in place and run it again."
  exit 2
}
