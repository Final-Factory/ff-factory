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
# vault-<user>-github; one whose file is gone is removed. Entries made in the VM (fffctl vault add-claude, w749) are copied
# here first, by vault_pull (the nightly's, and the first step of every sync): a sync never removes an entry that only the VM has. All of a person's Claude entries are their pool: the portal gives
# their runs those tokens only, soonest weekly reset first (docs/vault.md, section 4). Until w748 the names were
# host-<user>-claude, host-<user>-claude-<name> and host-<user>-github: `fffctl vault put` finds such an entry holding the
# same token and renames it (its meters, grants and sessions stay), and the old names are never removed while their file exists.

VAULT_PEOPLE=$FFF_VM_ETC/secrets/people
VAULT_KEY_COPY=$FFF_VM_ETC/secrets/vault.key
# What vault_pull keeps beside the people's files (docs/vault.md, section 12): an entry that is not one person's Claude or GitHub
# token (Max's Discord token, a settings-dialog entry), one folder per entry: value (0600), meta (its kind and grants).
VAULT_EXTRA=$FFF_VM_ETC/secrets/vault-extra
# The names the last sync found a file for: an entry in the VM with no file is one whose file was removed here (to be removed in
# the VM) when its name is on this list, and one added in the VM (to be copied here) when it is not.
VAULT_SEEN=$FFF_VM_ETC/secrets/vault-synced

vssh() {
  ssh -i "$FFF_VM_ETC/ssh/id_ed25519" -o UserKnownHostsFile="$FFF_VM_ETC/ssh/known_hosts" -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o BatchMode=yes -o LogLevel=ERROR "$VM_ADMIN_USER@$NET_VM_IP" "$@"
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

# vault_fp FILE: the vault's fingerprint of a file's value (the first 12 hex characters of the SHA-256 of the value without its
# whitespace: `fffctl vault list` shows the same). Names a value without showing it.
vault_fp() { tr -d '[:space:]' <"$1" | sha256sum | cut -c1-12; }
# vault_last4 FILE: the last four characters of a file's value, the one piece of it a log may carry.
vault_last4() { tr -d '[:space:]' <"$1" | tail -c 4; }

# vault_copy_ok KIND FILE: whether a value that came out of the VM is what its kind takes (read without printing it).
vault_copy_ok() {
  local v
  v=$(tr -d '[:space:]' <"$2")
  case "$1" in
    claude) [[ "$v" =~ ^sk-ant-oat01-[A-Za-z0-9_-]{40,}$ ]] ;;
    github) [[ "$v" =~ ^(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$ ]] ;;
    env) [ ${#v} -ge 8 ] && [ ${#v} -le 4096 ] ;;
    *) return 1 ;;
  esac
}

# vault_target NAME KIND OWNER: the file on this host that holds a VM entry: the person's claude-token, claude-tokens/<n> or
# github-token (the names vault_sync makes), else "extra" (kept in $VAULT_EXTRA). The owner's folder is the one that exists
# whatever its case. NAME, KIND and OWNER have been checked by the caller.
vault_target() {
  local name=$1 kind=$2 owner=$3 lower slot d
  if [ "$owner" != - ] && [[ "$owner" =~ ^[A-Za-z0-9._-]{1,30}$ ]]; then
    lower=$(tr '[:upper:]' '[:lower:]' <<<"$owner")
    for d in "$VAULT_PEOPLE"/*/; do
      [ -d "$d" ] || continue
      [ "$(tr '[:upper:]' '[:lower:]' <<<"$(basename "$d")")" = "$lower" ] && owner=$(basename "$d")
    done
    case "$kind" in
      claude)
        if [ "$name" = "vault-$lower" ]; then echo "$VAULT_PEOPLE/$owner/claude-token"; return; fi
        slot=${name#"vault-$lower-"}
        if [ "$slot" != "$name" ] && [ "$slot" != github ] && [[ "$slot" =~ ^[a-z0-9][a-z0-9._-]{0,15}$ ]]; then echo "$VAULT_PEOPLE/$owner/claude-tokens/$slot"; return; fi
        ;;
      github) if [ "$name" = "vault-$lower-github" ]; then echo "$VAULT_PEOPLE/$owner/github-token"; return; fi ;;
    esac
  fi
  echo extra
}

# vault_dir0700 DIR...: each folder made if missing and 0700 (a person's token folders are root's alone).
vault_dir0700() {
  local d
  for d in "$@"; do
    [ -d "$d" ] || (umask 077 && mkdir "$d")
    chmod 0700 "$d"
  done
}

# vault_fetch NAME KIND FP DEST: one value out of the VM into the new file DEST (0600), checked against the fingerprint the VM
# listed. Root to root over this host's own ssh, into a file: the value is never in an argument, a variable or a log.
vault_fetch() {
  local name=$1 kind=$2 fp=$3 dest=$4
  rm -f "$dest"
  # </dev/null: ssh reads stdin, which here is the list vault_pull is going through.
  if ! (umask 077 && vssh "sudo fffctl vault export $name" </dev/null >"$dest" 2>/dev/null); then
    rm -f "$dest"
    warn "vault: the VM would not export $name (is its portal updated? sudo fff-vm ssh 'sudo fffctl update')"
    return 1
  fi
  if [ "$(vault_fp "$dest")" != "$fp" ]; then
    rm -f "$dest"
    warn "vault: $name did not arrive as listed (the fingerprint differs); nothing kept"
    return 1
  fi
  if ! vault_copy_ok "$kind" "$dest"; then
    rm -f "$dest"
    warn "vault: $name is not what a $kind entry holds; nothing kept (its content is not shown)"
    return 1
  fi
  chmod 0600 "$dest"
}

# vault_pull: every entry that exists in the VM's vault and is missing here, copied to this host, so this host stays the full
# backup and a rebuilt VM gets them back (w749, docs/vault.md section 12). Runs before every sync and in the nightly. Rules:
#   - Claude pool tokens go to people/<owner>/claude-tokens/<n> (claude-token for vault-<owner>), GitHub tokens to github-token,
#     others (env entries, other names) to $VAULT_EXTRA/<name>/{value,meta}.
#   - A person's file is only ever CREATED here, never changed: when the host already has one and the value differs, the HOST
#     file wins (vault_sync then rotates the VM entry to it) and the difference is logged and reported (names, last four
#     characters, fingerprints). An extra is the VM's own: a changed value replaces the copy (the old one kept as value.prev).
#   - An entry whose name the last sync found a file for, and whose file is gone, was removed here on purpose: not copied back.
#   - Entries named host-… (before w748) are the sync's to rename. Disabled ones are copied like the rest.
# Returns 1 when something could not be listed or copied (each said why); 0 otherwise, conflicts included. VAULT_PULL_NEWS gets
# one line per conflict or failure, for the nightly's alert.
vault_pull() {
  local manifest line name kind env owner share roles machines fp last4 disabled target hostfp l4 tmp meta pdir rc=0 listed=0
  local copied=0 same=0 conflicts=0 skipped=0 gone=0 kept=0 d
  VAULT_PULL_NEWS=""
  if [ "${DRY_RUN:-0}" = 1 ]; then log "DRY-RUN would copy the VM's vault entries that are not here into $VAULT_PEOPLE and $VAULT_EXTRA"; return 0; fi
  if [ ! -f "$FFF_VM_ETC/ssh/id_ed25519" ]; then log "vault: no ssh key into the VM yet; nothing copied"; return 0; fi
  if ! manifest=$(vssh 'sudo fffctl vault export --manifest' 2>&1); then
    warn "vault: could not list the VM's vault entries for the copy (is the portal updated there? sudo fff-vm ssh 'sudo fffctl update'): ${manifest##*vault: }"
    VAULT_PULL_NEWS="the VM's vault entries were not copied (it could not list them)"
    return 1
  fi
  vault_dir0700 "$FFF_VM_ETC/secrets"
  tmp=$FFF_VM_ETC/secrets/.pull.$$
  while IFS= read -r line; do
    # One tab-separated line per entry, no value; anything else in the output is not an entry (a node warning, say).
    [[ "$line" == *$'\t'* ]] || continue
    # shellcheck disable=SC2034 # disabled: the last field is read, not used
    IFS=$'\t' read -r name kind env owner share roles machines fp last4 disabled <<<"$line"
    # The VM is the less trusted side of this copy: nothing it lists is used before it matches what a vault entry can be.
    if ! [[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,39}$ && "$kind" =~ ^(claude|github|env)$ && "$env" =~ ^(-|[A-Z][A-Z0-9_]{1,63})$ &&
      "$owner" =~ ^(-|[A-Za-z0-9._-]{1,64})$ && "$share" =~ ^(owner|anyone)$ && "$roles" =~ ^(workers|standing)(,(workers|standing))*$ &&
      "$machines" =~ ^(\*|[a-z0-9][a-z0-9-]*)(,(\*|[a-z0-9][a-z0-9-]*))*$ && "$fp" =~ ^[0-9a-f]{12}$ ]]; then
      warn "vault: an entry the VM listed is not shaped like a vault entry; skipped ($(tr -cd 'A-Za-z0-9._-' <<<"${name:0:40}"))"
      skipped=$((skipped + 1))
      rc=1
      continue
    fi
    listed=$((listed + 1))
    l4=$(tr -cd 'A-Za-z0-9_-' <<<"$last4")
    case "$name" in host-*) kept=$((kept + 1)); continue ;; esac
    target=$(vault_target "$name" "$kind" "$owner")
    if [ "$target" != extra ]; then
      if [ -f "$target" ]; then
        hostfp=$(vault_fp "$target")
        if [ "$hostfp" = "$fp" ]; then
          same=$((same + 1))
        else
          conflicts=$((conflicts + 1))
          warn "vault: conflict on $name: the VM holds …$l4 ($fp), the host file holds …$(vault_last4 "$target") ($hostfp); the host file wins and the next sync rotates the VM entry to it. To keep the VM's value instead, put it in $target"
          VAULT_PULL_NEWS+="$name differs between the VM (…$l4) and the host file (…$(vault_last4 "$target")): the host file wins. "
        fi
        continue
      fi
      if [ -f "$VAULT_SEEN" ] && grep -qxF -e "$name" "$VAULT_SEEN"; then
        gone=$((gone + 1))
        log "vault: not copied: $name (…$l4): its file was removed from this host on purpose; the next sync removes the entry from the VM"
        continue
      fi
      vault_fetch "$name" "$kind" "$fp" "$tmp" || { rc=1; VAULT_PULL_NEWS+="$name was not copied. "; continue; }
      # A classic GitHub token is not what the sync takes for github-token (fine-grained only): kept as an extra instead.
      if [ "$kind" = github ] && ! [[ "$(tr -d '[:space:]' <"$tmp")" =~ ^github_pat_ ]]; then
        target=extra
      else
        pdir=${target#"$VAULT_PEOPLE/"}
        vault_dir0700 "$FFF_VM_ETC/secrets" "$VAULT_PEOPLE" "$VAULT_PEOPLE/${pdir%%/*}" "$(dirname "$target")"
        if ln "$tmp" "$target" 2>/dev/null; then
          rm -f "$tmp"
          chmod 0600 "$target"
          copied=$((copied + 1))
          log "vault: copied $name (…$l4, $fp) from the VM to $target"
        else
          rm -f "$tmp"
          warn "vault: $target appeared while $name was being copied; the host file wins"
        fi
        continue
      fi
    fi
    # An entry that is not a person's claude/github token (or a GitHub token that is not fine-grained): an extra.
    d=$VAULT_EXTRA/$name
    if [ -f "$d/value" ] && [ "$(vault_fp "$d/value")" = "$fp" ]; then
      same=$((same + 1))
      continue
    fi
    [ -f "$tmp" ] || vault_fetch "$name" "$kind" "$fp" "$tmp" || { rc=1; VAULT_PULL_NEWS+="$name was not copied. "; continue; }
    vault_dir0700 "$FFF_VM_ETC/secrets" "$VAULT_EXTRA" "$d"
    hostfp=""
    if [ -f "$d/value" ]; then
      hostfp=$(vault_fp "$d/value")
      mv -f "$d/value" "$d/value.prev"
    fi
    mv -f "$tmp" "$d/value"
    meta=$d/meta.tmp
    (umask 077 && printf 'kind=%s\nenv=%s\nowner=%s\nshare=%s\nroles=%s\nmachines=%s\n' "$kind" "$env" "$owner" "$share" "$roles" "$machines" >"$meta")
    mv -f "$meta" "$d/meta"
    copied=$((copied + 1))
    if [ -n "$hostfp" ]; then
      log "vault: updated the copy of $name from the VM (…$l4, $fp; it was $hostfp; the old one kept as $d/value.prev)"
    else
      log "vault: copied $name (…$l4, $fp) from the VM to $d/value"
    fi
  done <<<"$manifest"
  rm -f "$tmp"
  log "vault: copy from the VM: $listed entries; $copied copied, $same already here, $conflicts conflicts, $gone deleted here, not copied back, $kept old host-… names, $skipped skipped"
  return "$rc"
}

# vault_restore_extras: the extras (Max's Discord token, ...) back into a VM that lacks them: a rebuilt VM, then the sync gets them
# from here. Only ever creates: an entry the VM has is never changed from here (it is the VM's own, vault_pull refreshes this
# copy). Returns 1 when one could not be put.
vault_restore_extras() {
  local d name kind env owner share roles machines args rc=0 have out
  [ -d "$VAULT_EXTRA" ] || return 0
  have=$(vssh 'sudo fffctl vault list --names') || return 1
  for d in "$VAULT_EXTRA"/*/; do
    [ -f "${d}value" ] && [ -f "${d}meta" ] || continue
    name=$(basename "$d")
    [[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,39}$ ]] || { warn "vault: $d is not named like an entry; skipped"; rc=1; continue; }
    grep -qxF -e "$name" <<<"$have" && continue
    kind=$(sed -n 's/^kind=//p' "${d}meta"); env=$(sed -n 's/^env=//p' "${d}meta"); owner=$(sed -n 's/^owner=//p' "${d}meta")
    share=$(sed -n 's/^share=//p' "${d}meta"); roles=$(sed -n 's/^roles=//p' "${d}meta"); machines=$(sed -n 's/^machines=//p' "${d}meta")
    if ! [[ "$kind" =~ ^(claude|github|env)$ && "$env" =~ ^(-|[A-Z][A-Z0-9_]{1,63})$ && "$owner" =~ ^(-|[A-Za-z0-9._-]{1,64})$ && "$share" =~ ^(owner|anyone)$ &&
      "$roles" =~ ^(workers|standing)(,(workers|standing))*$ && "$machines" =~ ^(\*|[a-z0-9][a-z0-9-]*)(,(\*|[a-z0-9][a-z0-9-]*))*$ ]]; then
      warn "vault: ${d}meta is not a vault entry's grants; $name not restored"
      rc=1
      continue
    fi
    args="--name $name --kind $kind --share $share --roles $roles --machines '$machines'"
    [ "$env" = - ] || args+=" --env $env"
    [ "$owner" = - ] || args+=" --owner $owner"
    # shellcheck disable=SC2029 # the entry is built on this side on purpose: every part of it matched a pattern above
    if out=$(vssh "sudo fffctl vault put $args --stdin" <"${d}value" 2>&1); then
      log "vault: restored $name into the VM (${out%%:*}, …$(vault_last4 "${d}value"))"
    else
      warn "vault: $name: ${out##*vault: }"
      rc=1
    fi
  done
  return "$rc"
}

# vault_sync: the VM's own entries copied here first (vault_pull), then every person's tokens from this host into the VM's vault,
# the entries whose file is gone removed, the extras put back into a VM that lacks them, and the key's spare copy brought up to
# date. Returns 1 when something was skipped (each said why), 0 otherwise. The installer's
# sync (guest.sh) and `fff-vm vault-sync` run this one function; install.sh keeps the installed copy of this file in step with
# the checkout in every mode (install_host_scripts, lib.sh). An entry whose file exists is never removed.
vault_sync() {
  local dir person lower name rc=0 kind file pulled=0 distrust=0
  local -a synced=()
  local -A legacy=() # an entry named as before w748 (host-…) -> the name it has now (vault-…)
  if [ "${DRY_RUN:-0}" = 1 ]; then log "DRY-RUN would sync $VAULT_PEOPLE/*/{claude,github}-token into the VM's vault"; return 0; fi
  vssh 'sudo fffctl vault list --names' >/dev/null 2>&1 || { warn "vault: the VM's portal has no vault yet (sudo fff-vm ssh 'sudo fffctl update' first)"; return 1; }
  # What only the VM has comes here before anything is removed there (w749). When it could not be copied, nothing is removed below:
  # an entry added in the VM is missing from the host's files until it is copied, and the sync would take it for one to delete.
  vault_pull || pulled=1
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
  local -a held=() extras=()
  local listed d
  for d in "$VAULT_EXTRA"/*/; do
    [ -f "${d}value" ] && extras+=("$(basename "$d")")
  done
  vault_restore_extras || rc=1
  listed=$(vssh 'sudo fffctl vault list --names') || listed=""
  for name in $listed; do
    case "$name" in vault-* | host-*) held+=("$name") ;; esac
  done
  if [ "$pulled" = 1 ]; then
    warn "vault: nothing was removed from the VM, because its own entries could not be copied here first (the warning above says why); run the sync again after that is fixed"
    rc=1
  elif [ ${#held[@]} -gt 0 ] && [ ${#synced[@]} -eq 0 ] && [ "${VAULT_PRUNE:-0}" != 1 ]; then
    warn "vault: found no token file under $VAULT_PEOPLE (claude-token, claude-tokens/<name>, github-token) but the vault holds ${held[*]}: removed none. If every person's files are really gone, run: sudo fff-vm vault-sync --prune"
    rc=1
    distrust=1
  else
    for name in "${held[@]}"; do
      [[ " ${synced[*]} ${extras[*]:-} " == *" $name "* ]] && continue
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
  # The names that have a file now: the next pull leaves an entry out when its file is removed (it is a deletion), and copies one
  # that is not on the list (it was added in the VM).
  # (Not after a scan that found no file at all: that list would say every entry was removed on purpose.)
  if [ "$pulled" = 0 ] && [ "$distrust" = 0 ]; then
    (umask 077 && printf '%s\n' "${synced[@]+"${synced[@]}"}" >"$VAULT_SEEN.tmp") && mv -f "$VAULT_SEEN.tmp" "$VAULT_SEEN"
  fi
  vault_key_copy || rc=1
  return "$rc"
}
