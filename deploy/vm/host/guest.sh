# shellcheck shell=bash
# The guest half of deploy/vm/host/install.sh (w498): the portal installed inside the VM and set up from the host's
# stored answers (answers.sh), over the host's own path into the VM ("fff-vm ssh": root's key, the private bridge).
# Sourced, never run. Each step looks at what the guest already has (fffctl state) and does only what is missing, so
# it is safe on a VM that is half or fully set up.
#
# Secrets go in through ssh's stdin into a root-only file on the guest's /run (a tmpfs: never on its disk), are handed
# to fffctl as a file, and are removed right after. Never on a command line (ssh's, sudo's or fffctl's).

TODO=()
todo() { TODO+=("$1"); }

# ssh into the VM as its admin account (as "fff-vm ssh" does); the host key is learned at the first connection.
gssh() {
  ssh -i "$FFF_VM_ETC/ssh/id_ed25519" -o UserKnownHostsFile="$FFF_VM_ETC/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR "$VM_ADMIN_USER@$NET_VM_IP" "$@"
}

# guest_state: fffctl state as JSON, or {} when the guest has no portal yet (or no fffctl that knows "state").
guest_state() {
  local out
  out=$(gssh 'command -v fffctl >/dev/null && sudo fffctl state' 2>/dev/null) || out='{}'
  jq -e . <<<"$out" >/dev/null 2>&1 && printf '%s\n' "$out" || echo '{}'
}

# Whether the VM is up and answers ssh now (no waiting).
guest_reachable() { [ "$(dom_state)" = running ] && gssh true >/dev/null 2>&1; }

# push_secret NAME: $SECRETS/NAME to /run/fff-install/NAME in the guest (root's, 0600), through stdin.
push_secret() {
  gssh 'sudo install -d -m 0700 -o root -g root /run/fff-install && sudo sh -c "umask 077 && cat >/run/fff-install/'"$1"'"' <"$SECRETS/$1"
}
drop_secret() { gssh 'sudo rm -f /run/fff-install/'"$1" || true; }

# The guest half. $1: a repository the guest builds the portal from (a host path to a git bundle), or empty for GitHub.
guest_setup() {
  local bundle=$1 st repo_arg="" url ip out
  log "11/12 the guest: waiting for the VM (first boot: cloud-init upgrades, installs and may reboot once; minutes)"
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would copy deploy/vm/guest into the VM, run its install.sh, then: claude-token, tailscale-join, gh-login,"
    log "DRY-RUN   base-clone, configure (ownerName, publicUrl, token-file accounts), backup-config and a first backup"
    return 0
  fi
  for _ in $(seq 240); do gssh 'cloud-init status --wait >/dev/null 2>&1; [ -f /var/lib/cloud/instance/boot-finished ]' >/dev/null 2>&1 && break; sleep 5; done
  gssh true || die "no ssh into the VM after 20 minutes: sudo fff-vm status; /var/log/libvirt/qemu/$VM_NAME-serial.log"
  log "the VM answers ssh; copying the guest scripts"
  # shellcheck disable=SC2154 # $here: the host scripts' folder, set by install.sh
  tar -C "$here/../guest" -cf - . | gssh 'rm -rf /tmp/fff-guest && mkdir -p /tmp/fff-guest && tar -xf - -C /tmp/fff-guest'
  if [ -n "$bundle" ]; then
    gssh 'cat >/tmp/ff.bundle && chmod 644 /tmp/ff.bundle' <"$bundle"
    repo_arg=" --repo /tmp/ff.bundle"
  fi
  log "the guest install (packages, the fff account, the first release, units; minutes)"
  gssh "sudo /tmp/fff-guest/install.sh --no-todo$repo_arg" || die "the guest install failed (above); run this again after fixing it"
  st=$(guest_state)
  jq -e .installed <<<"$st" >/dev/null || die "the guest install finished but fffctl state says the portal is not installed"

  log "12/12 the guest's settings"
  # 1. The subscription token (D4).
  if jq -e .claudeToken <<<"$st" >/dev/null; then log "claude token: stored in the VM"
  elif [ -s "$SECRETS/claude-token" ]; then
    push_secret claude-token
    if out=$(gssh 'sudo fffctl claude-token --file /run/fff-install/claude-token'); then log "claude token: ${out%%. Delete*}"
    else todo "the Claude subscription token: fffctl claude-token failed ($out)"; fi
    drop_secret claude-token
  else todo "the Claude subscription token: run this installer again in a terminal (it asks), or sudo fffctl claude-token in the VM"; fi

  # 2. Tailscale: join and Funnel. The key is one-use: once the node has joined, the stored copy is deleted.
  if jq -e .tailscale.joined <<<"$st" >/dev/null; then log "tailscale: joined ($(jq -r .tailscale.ip <<<"$st"))"
  elif [ "${GUEST_TAILSCALE:-join}" = skip ]; then todo "Tailscale: skipped (GUEST_TAILSCALE=skip in $CONF). Remove that line and run this again with a fresh auth key"
  elif ts_key_fresh; then
    push_secret tailscale-authkey
    if out=$(gssh 'sudo fffctl tailscale-join --authkey-file /run/fff-install/tailscale-authkey'); then
      log "tailscale: $(head -n 1 <<<"$out")"
      rm -f "$SECRETS/tailscale-authkey"
      log "tailscale: joined; the used auth key is deleted from $SECRETS"
    else
      todo "Tailscale: the join failed (above). Ask Ben for a fresh auth key and run this again"
    fi
    drop_secret tailscale-authkey
  else todo "Tailscale: no fresh auth key (they expire after a day). Ask Ben for one and run this again"; fi
  st=$(guest_state)
  url=$(jq -r '.tailscale.funnelUrl // ""' <<<"$st")
  ip=$(jq -r '.tailscale.ip // ""' <<<"$st")
  if jq -e .tailscale.joined <<<"$st" >/dev/null && [ -z "$url" ]; then todo "the Funnel URL is unknown (tailscale funnel status in the VM): set config.json publicUrl by hand"; fi

  # 3, 4. GitHub (D7), then the base clone the orchestrators read.
  if jq -e .github <<<"$st" >/dev/null; then log "github: logged in"
  elif [ "${GUEST_GITHUB:-token}" = skip ]; then todo "GitHub: skipped (GUEST_GITHUB=skip in $CONF). Remove that line and run this again with the token; the base clone follows"
  elif [ -s "$SECRETS/gh-token" ]; then
    push_secret gh-token
    if out=$(gssh 'sudo fffctl gh-login --token-file /run/fff-install/gh-token' 2>&1); then log "github: logged in"
    else todo "GitHub: the login failed ($(tail -n 1 <<<"$out")): check the token and run this again"; fi
    drop_secret gh-token
  fi
  st=$(guest_state)
  if jq -e .baseClone <<<"$st" >/dev/null; then log "base clone: present"
  elif jq -e .github <<<"$st" >/dev/null; then
    gssh 'sudo fffctl base-clone' || todo "the base clone failed (above): sudo fffctl base-clone in the VM"
  fi

  # 5. config.json: ownerName, publicUrl (the Funnel URL), the orchestrators and the dispatcher on the token file.
  local args=""
  [ "$(jq -r '.config.ownerName // ""' <<<"$st")" = "$PORTAL_OWNER_NAME" ] || args+=" --owner-name $(printf %q "$PORTAL_OWNER_NAME")"
  [ -z "$url" ] || [ "$(jq -r '.config.publicUrl // ""' <<<"$st")" = "$url" ] || args+=" --public-url $(printf %q "$url")"
  if jq -e .claudeToken <<<"$st" >/dev/null && ! jq -e .config.tokenfile <<<"$st" >/dev/null; then args+=" --claude-tokenfile"; fi
  if [ -n "$args" ]; then
    # shellcheck disable=SC2086
    gssh "sudo fffctl configure$args" || todo "config.json: fffctl configure failed (above)"
  else log "config.json: ownerName, publicUrl and the accounts already set"; fi

  # 6. Backups (D17).
  if [ -n "${GUEST_BACKUP_SSH_TARGET:-}" ]; then
    if [ "$(jq -r '.backup.target // ""' <<<"$st")" != "$GUEST_BACKUP_SSH_TARGET" ] || [ "$(jq -r '.backup.recipients // 0' <<<"$st")" = 0 ]; then
      [ -s "$RECIPIENTS_FILE" ] && gssh 'cat >/tmp/fff-recipients.txt' <"$RECIPIENTS_FILE"
      gssh "sudo fffctl backup-config --target $(printf %q "$GUEST_BACKUP_SSH_TARGET")$([ -s "$RECIPIENTS_FILE" ] && echo ' --recipients-file /tmp/fff-recipients.txt'); rm -f /tmp/fff-recipients.txt" ||
        todo "backups: fffctl backup-config failed (above)"
    fi
    if out=$(gssh 'sudo fffctl backup' 2>&1); then log "backups: a first backup went to $GUEST_BACKUP_SSH_TARGET"
    else
      todo "backups: the first backup to $GUEST_BACKUP_SSH_TARGET failed ($(tail -n 1 <<<"$out")). Authorize this key there (one line in ~/.ssh/authorized_keys of that account), then sudo fffctl backup in the VM:
      restrict $(gssh 'cat /etc/fff/backup_ed25519.pub' 2>/dev/null || echo '(the VM'"'"'s /etc/fff/backup_ed25519.pub)')"
    fi
  else todo "backups: off (no target). Run this again in a terminal with GUEST_BACKUP_SSH_TARGET removed from $CONF to set them up"; fi

  # 7. The portal's key for deploying machine daemons (docs, 4.3): from= the VM's tailnet address.
  local key
  key=$(gssh 'sudo cat /srv/fff/home/.ssh/id_ed25519.pub' 2>/dev/null || true)
  if [ -n "$key" ] && [ -n "$ip" ]; then
    todo "the portal's deploy key, on each machine it deploys to (BEAST, LothDesktop, M3, M5): add this line to ~/.ssh/authorized_keys (a Windows admin account: C:\\ProgramData\\ssh\\administrators_authorized_keys):
      from=\"$ip\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding $key"
  elif [ -n "$key" ]; then
    todo "the portal's deploy key: once Tailscale is joined, run this again and it prints the from= line for each machine"
  fi

  # 8. The token vault (docs/vault.md, "Whose tokens"): each person's tokens kept here go into the VM's vault, and its
  # key's spare copy comes back here. A rebuilt VM gets them back from here (its backups leave the vault out).
  # shellcheck source=vault.sh
  . "$here/vault.sh"
  if [ -d "$FFF_VM_ETC/secrets/people" ] || [ ! -f "$FFF_VM_ETC/secrets/vault.key" ]; then
    vault_sync || todo "the token vault: not every token went in (the warnings above say why); fix that, then sudo fff-vm vault-sync"
  fi

  st=$(guest_state)
  jq -e .portal.healthy <<<"$st" >/dev/null || todo "the portal does not answer /api/health: sudo fff-vm ssh, then sudo fffctl status and sudo fffctl logs"
  gssh 'sudo fffctl status' || true
}

# The short list of what the installer could not do itself, each with why.
print_todo() {
  if [ ${#TODO[@]} -eq 0 ]; then log "everything is set up"; return 0; fi
  printf '\nLeft for a person:\n' >&2
  local t
  for t in "${TODO[@]}"; do printf '  - %s\n' "$t" >&2; done
}
