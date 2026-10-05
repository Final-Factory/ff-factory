# shellcheck shell=bash
# Shared by the portal VM's guest scripts (deploy/vm/guest; installed in /usr/local/lib/fff). Sourced, never run.
set -o errexit -o nounset -o pipefail

FFF_LIB=${FFF_LIB:-/usr/local/lib/fff}
FFF_CONF=${FFF_CONF:-/etc/fff/fff.conf}
DRY_RUN=${DRY_RUN:-0}

log() { printf '%s fff: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
warn() { log "WARNING: $*"; }
die() { log "ERROR: $*"; exit 1; }
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
as_fff() { runuser -u "$FFF_USER" -- env HOME="$FFF_ROOT/home" GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0 "$@"; }

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
release_sha() { [ -n "$1" ] && as_fff git -C "$1" rev-parse HEAD 2>/dev/null; }
portal_active() { systemctl is-active --quiet fff-portal.service; }
