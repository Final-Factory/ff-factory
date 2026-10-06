# shellcheck shell=bash
# The token vault's host side (docs/vault.md, "Whose tokens", w512). Sourced by fff-vm (fff-vm vault-sync) and by the
# installer's guest step (guest.sh), never run.
#
# lothsahn, 2026-10-06: each person's Claude and GitHub tokens are kept on this host, root only, next to what the
# installer already keeps (decision D2: root here can read the VM anyway). The VM's vault gets them from here:
#   /etc/fff-vm/secrets/people/<user id>/claude-token    one 'claude setup-token' token (sk-ant-oat01-...)
#   /etc/fff-vm/secrets/people/<user id>/github-token    one fine-grained GitHub token (github_pat_...)
#   /etc/fff-vm/secrets/vault.key                        the spare copy of the VM's vault key (kept in step with it)
# Each value goes into the VM only over ssh's stdin, to `fffctl vault put`, and is never on a command line, in a log or in
# the VM's daily backup (fff-backup leaves data/vault.json out; this host is where a rebuilt VM gets them back from).
# The vault entries it makes are named host-<user>-claude and host-<user>-github; one whose file is gone is removed.

VAULT_PEOPLE=$FFF_VM_ETC/secrets/people
VAULT_KEY_COPY=$FFF_VM_ETC/secrets/vault.key

vssh() {
  ssh -i "$FFF_VM_ETC/ssh/id_ed25519" -o UserKnownHostsFile="$FFF_VM_ETC/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR "$VM_ADMIN_USER@$NET_VM_IP" "$@"
}

# vault_value_ok KIND FILE: whether FILE holds what that kind takes, read without printing it.
vault_value_ok() {
  local v
  v=$(tr -d '[:space:]' <"$2")
  case "$1" in
    claude) [[ "$v" =~ ^sk-ant-oat01-[A-Za-z0-9_-]{40,}$ ]] ;;
    github) [[ "$v" =~ ^github_pat_[A-Za-z0-9_]{30,}$ ]] ;;
    *) return 1 ;;
  esac
}

# vault_put NAME KIND OWNER FILE: the value into the vault through ssh's stdin. Prints added, rotated, regranted or unchanged.
vault_put() {
  local out
  if ! out=$(vssh "sudo fffctl vault put --name $1 --kind $2 --owner $3 --share owner --roles workers,standing --machines '*' --stdin" <"$4" 2>&1); then
    warn "vault: $1: ${out##*vault: }"
    return 1
  fi
  log "vault: ${out%%:*} $1"
}

# vault_key_copy: keep the spare copy of the VM's vault key in step with it (the one before kept as .prev).
vault_key_copy() {
  local vm host=""
  vm=$(vssh 'sudo sha256sum /etc/fff/vault.key 2>/dev/null' | cut -d' ' -f1) || true
  [ -n "$vm" ] || { warn "vault: the VM has no vault key yet (its guest install makes one)"; return 1; }
  [ ! -f "$VAULT_KEY_COPY" ] || host=$(sha256sum "$VAULT_KEY_COPY" | cut -d' ' -f1)
  [ "$vm" != "$host" ] || return 0
  install -d -m 0700 -o root -g root "$FFF_VM_ETC/secrets"
  (umask 077 && vssh 'sudo cat /etc/fff/vault.key' >"$VAULT_KEY_COPY.tmp")
  [ "$(sha256sum "$VAULT_KEY_COPY.tmp" | cut -d' ' -f1)" = "$vm" ] || { rm -f "$VAULT_KEY_COPY.tmp"; warn "vault: the key copy did not arrive whole"; return 1; }
  [ ! -f "$VAULT_KEY_COPY" ] || mv -f "$VAULT_KEY_COPY" "$VAULT_KEY_COPY.prev"
  mv -f "$VAULT_KEY_COPY.tmp" "$VAULT_KEY_COPY"
  log "vault: the key's spare copy is $VAULT_KEY_COPY (0600)"
}

# vault_sync: every person's tokens from this host into the VM's vault, the entries whose file is gone removed, and the
# key's spare copy brought up to date. Returns 1 when something was skipped (each said why), 0 otherwise.
vault_sync() {
  local dir person lower name rc=0 kind file
  local -a synced=()
  if [ "${DRY_RUN:-0}" = 1 ]; then log "DRY-RUN would sync $VAULT_PEOPLE/*/{claude,github}-token into the VM's vault"; return 0; fi
  vssh 'sudo fffctl vault list --names' >/dev/null 2>&1 || { warn "vault: the VM's portal has no vault yet (sudo fff-vm ssh 'sudo fffctl update' first)"; return 1; }
  if [ -d "$VAULT_PEOPLE" ]; then
    chmod 0700 "$FFF_VM_ETC/secrets" "$VAULT_PEOPLE"
    for dir in "$VAULT_PEOPLE"/*/; do
      [ -d "$dir" ] || continue
      person=$(basename "$dir")
      [[ "$person" =~ ^[A-Za-z0-9._-]{1,30}$ ]] || { warn "vault: $dir is not named for a portal user id; skipped"; rc=1; continue; }
      lower=$(tr '[:upper:]' '[:lower:]' <<<"$person")
      for kind in claude github; do
        file=$dir$kind-token
        [ -s "$file" ] || continue
        chmod 0600 "$file"
        name=host-$lower-$kind
        if ! vault_value_ok "$kind" "$file"; then
          warn "vault: $file is not $([ "$kind" = claude ] && echo "one 'claude setup-token' token (sk-ant-oat01-...)" || echo 'one fine-grained GitHub token (github_pat_...)'); skipped (its content is not shown)"
          rc=1
          continue
        fi
        synced+=("$name")
        vault_put "$name" "$kind" "$person" "$file" || rc=1
      done
    done
  fi
  for name in $(vssh 'sudo fffctl vault list --names'); do
    case "$name" in host-*) ;; *) continue ;; esac
    [[ " ${synced[*]} " == *" $name "* ]] && continue
    vssh "sudo fffctl vault remove $name" >/dev/null && log "vault: removed $name (its file is gone from $VAULT_PEOPLE)"
  done
  vault_key_copy || rc=1
  return "$rc"
}
