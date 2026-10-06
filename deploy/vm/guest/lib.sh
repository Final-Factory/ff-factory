# shellcheck shell=bash
# Shared by the portal VM's guest scripts (deploy/vm/guest; installed in /usr/local/lib/fff). Sourced, never run.
set -o errexit -o nounset -o pipefail

# A root PATH of its own: fff-update also runs as fff-portal.service's ExecStartPre, which inherits that unit's PATH
# (no sbin), and runuser is in /usr/sbin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
FFF_LIB=${FFF_LIB:-/usr/local/lib/fff}
FFF_CONF=${FFF_CONF:-/etc/fff/fff.conf}
# The token vault's key (docs/vault.md): root only, outside the data folder; fff-portal.service loads it as a credential.
FFF_VAULT_KEY=${FFF_VAULT_KEY:-/etc/fff/vault.key}
DRY_RUN=${DRY_RUN:-0}

log() { printf '%s fff: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
warn() { log "WARNING: $*"; }
die() { log "ERROR: $*"; exit 1; }
# matches ARGS...: grep that reads all of its input. "grep -q" stops at the first match, and the writer of a pipe into it
# then dies of SIGPIPE, which pipefail turns into a failure (nft 1.1 on Ubuntu 26.04 hit it).
matches() { grep "$@" >/dev/null; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 ...)"; }

run_cmd() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY-RUN would run:' >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
  else
    "$@"
  fi
}

# write_file PATH MODE [OWNER]: stdin to PATH when it differs; prints "changed" when it wrote (or would).
write_file() {
  local path=$1 mode=$2 owner=${3:-root:root} tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then
    log "DRY-RUN would write $path ($mode, $owner, $(wc -c <"$tmp") bytes)"
  else
    install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
  fi
  rm -f "$tmp"
  echo changed
}

# install_scripts SRC: every helper script from SRC (a deploy/vm/guest folder) to where the VM runs it: fffctl in
# /usr/local/sbin, the rest in $FFF_LIB. install.sh does it from its clone; fff-update from each release it switches to,
# so "fffctl update" keeps fffctl and its helpers as new as the portal. Prints the names it changed. write_file replaces
# a file by a new one (install), so a script running from the old copy reads on undisturbed.
install_scripts() {
  local src=$1 f c=""
  run_cmd install -d -m 0755 "$FFF_LIB"
  for f in lib.sh fff.conf.example config.vm.example.json machines.ssh; do [ -z "$(write_file "$FFF_LIB/$f" 0644 <"$src/$f")" ] || c+=" $f"; done
  for f in fff-update fff-health fff-backup fff-base-refresh fff-migrate fff-machine-ssh; do [ -z "$(write_file "$FFF_LIB/$f" 0755 <"$src/$f")" ] || c+=" $f"; done
  [ -z "$(write_file /usr/local/sbin/fffctl 0755 <"$src/fffctl")" ] || c+=" fffctl"
  echo "${c# }"
}

# tailnet_url: this VM's own https address on the tailnet (https://<node>.<tailnet>.ts.net, the Funnel URL), or nothing
# while Tailscale has not joined.
tailnet_url() {
  command -v tailscale >/dev/null || return 0
  tailscale status --json 2>/dev/null | jq -r 'if .BackendState == "Running" then (.Self.DNSName // "" | rtrimstr(".")) else "" end' 2>/dev/null |
    sed -nE 's#^(.+)$#https://\1#p' || true
}

# sync_public_url: config.json publicUrl (machines and the outside watchdog reach the portal there) set to tailnet_url
# when it is empty or another ts.net address (a renamed node, a copy from another portal). A URL off ts.net was set by
# a person on purpose and stays. Succeeds when it changed the file, so the caller restarts the portal.
sync_public_url() {
  local cfg=$FFF_ROOT/config/config.json want have tmp
  [ -f "$cfg" ] || return 1
  want=$(tailnet_url)
  if [ -z "$want" ]; then log "publicUrl: Tailscale has not joined yet, so it stays as it is (fffctl tailscale-join sets it)"; return 1; fi
  have=$(jq -r '.publicUrl // ""' "$cfg" 2>/dev/null || true)
  have=${have%/}
  [ "$have" != "$want" ] || return 1
  if [ -n "$have" ] && ! printf '%s' "$have" | matches -E '^https://[^/]+\.ts\.net$'; then
    log "publicUrl: $have is not on ts.net, so it stays (this VM's tailnet address is $want)"
    return 1
  fi
  if [ "$DRY_RUN" = 1 ]; then log "DRY-RUN would set config.json publicUrl to $want (was ${have:-empty})"; return 1; fi
  tmp=$(mktemp "$FFF_ROOT/config/.config.XXXXXX")
  jq --arg url "$want" '.publicUrl = $url' "$cfg" >"$tmp" || { rm -f "$tmp"; warn "could not edit $cfg"; return 1; }
  chown "$FFF_USER:$FFF_USER" "$tmp"
  chmod 0600 "$tmp"
  cp -p "$cfg" "$cfg.prev"
  mv -f "$tmp" "$cfg"
  log "publicUrl: set to $want (was ${have:-empty})"
}

load_conf() {
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=fff.conf.example
  . "$here/fff.conf.example"
  # shellcheck disable=SC1090
  [ ! -f "$FFF_CONF" ] || . "$FFF_CONF"
  # What the host's install.sh told the guest (cloud-init): its address, ours, the portal's port.
  # shellcheck disable=SC1091
  [ ! -f /etc/fff-vm-guest.env ] || . /etc/fff-vm-guest.env
  FFF_HOST_IP=${FFF_HOST_IP:-}
  FFF_ADMIN_USER=${FFF_ADMIN_USER:-}
  # Read by the scripts that source this.
  # shellcheck disable=SC2034
  DATA=$FFF_ROOT/data APP=$FFF_ROOT/app REPO=$FFF_ROOT/app/repo.git RELEASES=$FFF_ROOT/app/releases \
    CURRENT=$FFF_ROOT/app/current PREVIOUS=$FFF_ROOT/app/previous
}

# as_fff CMD...: run as the service account, in its home, with git's LFS smudge off (no LFS downloads anywhere here).
# It starts in /, not the caller's folder: the admin's home is closed to fff, and git and gh fail on a cwd they cannot
# stat ("fatal: failed to stat '/home/fffadmin/ff-factory': Permission denied" from fffctl gh-login).
as_fff() { as_fff_in / "$@"; }
# as_fff_in DIR CMD...: the same, started in DIR.
as_fff_in() { local dir=$1; shift; (cd "$dir" && runuser -u "$FFF_USER" -- env HOME="$FFF_ROOT/home" GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0 "$@"); }

# data_write NAME: stdin to $DATA/NAME, whole (a temp file and a rename) and owned by fff, which the server needs to
# read and remove it.
data_write() {
  local tmp
  tmp=$(mktemp "$DATA/.$1.XXXXXX")
  cat >"$tmp"
  chown "$FFF_USER:$FFF_USER" "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$DATA/$1"
}

# tell_dispatcher TEXT: a system message to the dispatcher through data/orchestrator-inbox (server/index.ts reads
# *.txt there every 5 s and sends each once), for what happens outside the server: a failed build, a rollback.
tell_dispatcher() {
  local dir=$DATA/orchestrator-inbox name tmp
  install -d -m 0700 -o "$FFF_USER" -g "$FFF_USER" "$dir"
  name="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  tmp="$dir/.$name.tmp"
  printf '%s\n' "$1" >"$tmp"
  chown "$FFF_USER:$FFF_USER" "$tmp"
  mv -f "$tmp" "$dir/$name.txt"
}

health_json() { curl -fsS -m 10 "http://127.0.0.1:$FFF_PORT/api/health"; }
# As fff: root running git in fff's repository trips git's safe.directory check.
# Empty (and status 0) when there is no such release, so an assignment from it never stops a set -e script.
release_sha() { if [ -n "$1" ]; then as_fff git -C "$1" rev-parse HEAD 2>/dev/null || true; fi; }
portal_active() { systemctl is-active --quiet fff-portal.service; }
