# shellcheck shell=bash
# The token vault's host side (docs/vault.md, "Whose tokens", w512). Sourced by fff-vm (fff-vm vault-sync) and by the
# installer's guest step (guest.sh), never run.
#
# lothsahn, 2026-10-06: each person's Claude and GitHub tokens are kept on this host, root only, next to what the
# installer already keeps (decision D2: root here can read the VM anyway). The VM's vault gets them from here:
#   /etc/fff-vm/secrets/people/<user id>/claude-token    one 'claude setup-token' token (sk-ant-oat01-...)
#   /etc/fff-vm/secrets/people/<user id>/claude-tokens/<name>
#                                                        more of them, one token per file (w739: a person's pool; the
#                                                        <name> is 1-16 of a-z 0-9 . _ - and starts with a letter or digit)
#   /etc/fff-vm/secrets/people/<user id>/github-token    one fine-grained GitHub token (github_pat_...)
#   /etc/fff-vm/secrets/vault.key                        the spare copy of the VM's vault key (kept in step with it)
# Each value goes into the VM only over ssh's stdin, to `fffctl vault put`, and is never on a command line, in a log or in
# the VM's daily backup (fff-backup leaves data/vault.json out; this host is where a rebuilt VM gets them back from).
# The vault entries it makes are named vault-<user> (claude-token), vault-<user>-<name> (each file of claude-tokens/) and
# vault-<user>-github; one whose file is gone is removed. All of a person's Claude entries are their pool: the portal gives
# their runs those tokens only, soonest weekly reset first (docs/vault.md, section 4). Until w748 the names were
# host-<user>-claude, host-<user>-claude-<name> and host-<user>-github: `fffctl vault put` finds such an entry holding the
# same token and renames it (its meters, grants and sessions stay), and the old names are never removed while their file exists.

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
# key's spare copy brought up to date. Returns 1 when something was skipped (each said why), 0 otherwise. The installer's
# sync (guest.sh) and `fff-vm vault-sync` run this one function; install.sh keeps the installed copy of this file in step with
# the checkout in every mode (install_host_scripts, lib.sh). An entry whose file exists is never removed.
vault_sync() {
  local dir person lower name rc=0 kind file
  local -a synced=()
  local -A legacy=() # an entry named as before w748 (host-…) -> the name it has now (vault-…)
  if [ "${DRY_RUN:-0}" = 1 ]; then log "DRY-RUN would sync $VAULT_PEOPLE/*/{claude,github}-token into the VM's vault"; return 0; fi
  vssh 'sudo fffctl vault list --names' >/dev/null 2>&1 || { warn "vault: the VM's portal has no vault yet (sudo fff-vm ssh 'sudo fffctl update' first)"; return 1; }
  if [ -d "$VAULT_PEOPLE" ]; then
    chmod 0700 "$FFF_VM_ETC/secrets" "$VAULT_PEOPLE"
    for dir in "$VAULT_PEOPLE"/*/; do
      [ -d "$dir" ] || continue
      person=$(basename "$dir")
      [[ "$person" =~ ^[A-Za-z0-9._-]{1,30}$ ]] || { warn "vault: $dir is not named for a portal user id; skipped"; rc=1; continue; }
      lower=$(tr '[:upper:]' '[:lower:]' <<<"$person")
      # The single files, then the pool's extra tokens (claude-tokens/<name>): "kind|file|vault entry name|name before w748" per token.
      local -a todo=()
      todo+=("claude|${dir}claude-token|vault-$lower|host-$lower-claude" "github|${dir}github-token|vault-$lower-github|host-$lower-github")
      if [ -d "${dir}claude-tokens" ]; then
        chmod 0700 "${dir}claude-tokens"
        for file in "${dir}claude-tokens"/*; do
          [ -f "$file" ] || continue
          local slot
          slot=$(tr '[:upper:]' '[:lower:]' <<<"$(basename "$file")")
          [[ "$slot" =~ ^[a-z0-9][a-z0-9._-]{0,15}$ ]] || { warn "vault: $file is not named 1-16 of a-z 0-9 . _ - (starting with a letter or digit); skipped"; rc=1; continue; }
          todo+=("claude|$file|vault-$lower-$slot|host-$lower-claude-$slot")
        done
      fi
      local item
      for item in "${todo[@]}"; do
        IFS='|' read -r kind file name old <<<"$item"
        [ -f "$file" ] || continue
        chmod 0600 "$file"
        # Two files cannot share an entry: person "ben" with a pool file "github" and a github-token, or person "ben-1" and
        # person "ben" with a pool file "1". The first wins, the second is said.
        if [[ " ${synced[*]} " == *" $name "* ]]; then
          warn "vault: $file would make the entry $name, which another file already makes; skipped (rename it)"
          rc=1
          continue
        fi
        # Named before it is checked: an entry whose file exists is never removed, even when the file is not a token now (a bad paste).
        synced+=("$name")
        legacy["$old"]=$name
        if ! vault_value_ok "$kind" "$file"; then
          warn "vault: $file is not $([ "$kind" = claude ] && echo "one 'claude setup-token' token (sk-ant-oat01-...)" || echo 'one fine-grained GitHub token (github_pat_...)'); skipped (its content is not shown)"
          rc=1
          continue
        fi
        vault_put "$name" "$kind" "$person" "$file" || rc=1
      done
    done
  fi
  # Entries whose file is gone are removed. A scan that found no token file at all while the vault holds vault-* or host-*
  # entries is not trusted (a folder that moved, a script that does not know a layout: w744 removed a whole pool this way):
  # nothing is removed then, unless `fff-vm vault-sync --prune` says so.
  local -a held=()
  local listed
  listed=$(vssh 'sudo fffctl vault list --names') || listed=""
  for name in $listed; do
    case "$name" in vault-* | host-*) held+=("$name") ;; esac
  done
  if [ ${#held[@]} -gt 0 ] && [ ${#synced[@]} -eq 0 ] && [ "${VAULT_PRUNE:-0}" != 1 ]; then
    warn "vault: found no token file under $VAULT_PEOPLE (claude-token, claude-tokens/<name>, github-token) but the vault holds ${held[*]}: removed none. If every person's files are really gone, run: sudo fff-vm vault-sync --prune"
    rc=1
  else
    for name in "${held[@]}"; do
      [[ " ${synced[*]} " == *" $name "* ]] && continue
      # An entry under the name before w748 whose file still exists is kept until the entry under its new name is in the
      # vault: the portal renames it when it takes the same token (fffctl vault put). One left over beside the new entry
      # holds another token (the file was changed meanwhile): its file now feeds the new entry, so it goes.
      if [ -n "${legacy[$name]:-}" ]; then
        if [[ " ${held[*]} " == *" ${legacy[$name]} "* ]]; then
          vssh "sudo fffctl vault remove $name" >/dev/null && log "vault: removed $name (its file now feeds ${legacy[$name]})"
        else
          warn "vault: $name stays: its new name ${legacy[$name]} is not in the vault yet (the portal needs fffctl update for the rename); run the sync again after it"
          rc=1
        fi
        continue
      fi
      vssh "sudo fffctl vault remove $name" >/dev/null && log "vault: removed $name (its file is gone from $VAULT_PEOPLE)"
    done
  fi
  vault_key_copy || rc=1
  return "$rc"
}
