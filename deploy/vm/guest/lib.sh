# shellcheck shell=bash
# Shared by the portal VM's guest scripts (deploy/vm/guest; installed in /usr/local/lib/fff). Sourced, never run.
set -o errexit -o nounset -o pipefail

# A root PATH of its own: fff-update also runs as fff-portal.service's ExecStartPre, which inherits that unit's PATH
# (no sbin), and runuser is in /usr/sbin.
# (FFF_PATH_PREFIX: only the unit tests set it, for a jq that is not in the system folders.)
export PATH=${FFF_PATH_PREFIX:+$FFF_PATH_PREFIX:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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
# FFF_TEST_NOROOT=1: the unit tests (deploy/vm/test) run the scripts as themselves, against fakes.
need_root() { [ "$(id -u)" -eq 0 ] || [ "${FFF_TEST_NOROOT:-}" = 1 ] || die "run as root (sudo $0 ...)"; }

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
  for f in fff-update fff-health fff-watchdog fff-backup fff-base-refresh fff-migrate fff-machine-ssh fff-ops-launch fff-ops-priv fff-ops-ssh fff-ops-scp-ssh fff-ops-sync; do [ -z "$(write_file "$FFF_LIB/$f" 0755 <"$src/$f")" ] || c+=" $f"; done
  # The orchestration worker's PATH (w597): its ssh and fffctl, each one sudo call to a wrapper above; its scp and sftp
  # (w612), /usr/bin/scp and sftp as itself over fff-ops-scp-ssh; its fff-machine-ssh (w676), through fff-ops-priv.
  for f in ssh fffctl scp sftp fff-machine-ssh; do [ -z "$(write_file "$FFF_LIB/ops-bin/$f" 0755 <"$src/ops-bin/$f")" ] || c+=" ops-bin/$f"; done
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
  cp -p --remove-destination "$cfg" "$cfg.prev"
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
    CURRENT=$FFF_ROOT/app/current PREVIOUS=$FFF_ROOT/app/previous PREPARED=$FFF_ROOT/app/update.prepared.json
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
# The temp file is mktemp's, never a name fff could have put a symbolic link at first (w5505).
tell_dispatcher() {
  local dir=$DATA/orchestrator-inbox name tmp
  install -d -m 0700 -o "$FFF_USER" -g "$FFF_USER" "$dir"
  name="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  tmp=$(mktemp "$dir/.$name.XXXXXX")
  printf '%s\n' "$1" >"$tmp"
  chown "$FFF_USER:$FFF_USER" "$tmp"
  mv -f "$tmp" "$dir/$name.txt"
}

health_json() { curl -fsS -m 10 "http://127.0.0.1:$FFF_PORT/api/health"; }
# As fff: root running git in fff's repository trips git's safe.directory check.
# Empty (and status 0) when there is no such release, so an assignment from it never stops a set -e script.
# A root-owned release (w5505) is read by root, an older one fff made by fff.
release_sha() {
  [ -n "$1" ] || return 0
  if root_owned "$1"; then git_root -C "$1" rev-parse HEAD 2>/dev/null || true; else as_fff git -C "$1" rev-parse HEAD 2>/dev/null || true; fi
}
portal_active() { sc is-active --quiet fff-portal.service; }

# ---------------------------------------------------------------- the critical units (w698)
# Every unit the portal VM needs running, in the order they depend on each other. One list for all of it: install.sh
# enables each one (and fails if one stays disabled), fff-health restarts any that is failed or stopped, fffctl status
# shows them, and deploy/vm/test/fff-units.test.sh checks that each has an [Install] section and is enabled by install.sh.
# A new unit the portal cannot do without goes here and nowhere else.
#   fff-guest-firewall   the VM's own nftables table: without it nothing is filtered
#   tailscaled           the tailnet and Funnel: without it the portal is unreachable
#   fff-ops-scratch      the orchestration worker's scratch file system
#   fff-ops.socket       the orchestration worker's door (/run/fff-ops/claude.sock)
#   fff-portal           the portal
#   fff-update.path      starts fff-update.service when an update is asked for
#   fff-health.timer     the watchdog itself (only the FFBox host's fff-vm watch can notice it stopped)
#   fff-backup.timer fff-base-refresh.timer   the daily backup and the base clone's refresh
# shellcheck disable=SC2034 # read by the scripts that source this
FFF_CRITICAL_UNITS=(
  fff-guest-firewall.service
  tailscaled.service
  fff-ops-scratch.service
  fff-ops.socket
  fff-portal.service
  fff-update.path
  fff-health.timer
  fff-backup.timer
  fff-base-refresh.timer
)

# sc ARGS...: systemctl (FFF_SYSTEMCTL replaces it in the tests).
sc() { "${FFF_SYSTEMCTL:-systemctl}" "$@"; }
# unit_get UNIT PROPERTY: one property of a unit ("" when systemctl does not know it).
unit_get() { sc show -p "$2" --value "$1" 2>/dev/null || true; }
# enable_state_ok STATE: UnitFileState values that start at boot (static and indirect units are pulled in by another).
enable_state_ok() { case "$1" in enabled | enabled-runtime | static | indirect | generated | alias | transient) return 0 ;; *) return 1 ;; esac; }

# render_unit FILE VAR|VAR=VALUE...: FILE (a units/*.in template) with every @VAR@ replaced by the value of the shell variable
# VAR, or by VALUE for VAR=VALUE.
# A token left over means the template names a variable the caller did not give: an error, never a half-written unit.
render_unit() {
  local file=$1 text arg
  shift
  # bash 5.2: "&" in a replacement would mean the matched text
  shopt -u patsub_replacement 2>/dev/null || true
  text=$(cat "$file")
  for arg in "$@"; do
    case $arg in
      *=*) text=${text//@${arg%%=*}@/${arg#*=}} ;;
      *) text=${text//@$arg@/${!arg}} ;;
    esac
  done
  if printf '%s' "$text" | grep -Eo '@[A-Z_]+@' >/dev/null; then
    die "$file: no value for $(printf '%s' "$text" | grep -Eo '@[A-Z_]+@' | sort -u | paste -sd' ' -)"
  fi
  printf '%s\n' "$text"
}

# ---------------------------------------------------------------- release trees root runs code from (w5505)
# fff-update runs as root and runs a release's guest install.sh and installs its fffctl and helpers (fff-update activate,
# rollback, request). So the record of the prepared release, the bare clone, the release folders and the current and
# previous links are root's and read-only to fff ($APP, 0755), and root takes a release only after release_problem finds
# nothing wrong with it: code running as fff (the portal, its agents) can ask for an update of a commit on
# origin/$FFF_BRANCH (data/update.wanted, fff-update.path) and nothing more. docs/portal-on-ffbox-host.md, "Releases".

# git_root ARGS...: git as root, in root's clone and release trees only, with no hooks and no fsmonitor command.
git_root() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }

# root_owned PATH...: each exists, is root's and is writable by nobody else (a symbolic link: root's).
# FFF_TRUSTED_UID: the tests' stand-in for root's uid 0.
root_owned() {
  local p uid=${FFF_TRUSTED_UID:-0}
  for p in "$@"; do
    if [ -L "$p" ]; then
      [ -n "$(find "$p" -maxdepth 0 -user "$uid" 2>/dev/null)" ] || return 1
    else
      [ -e "$p" ] || return 1
      [ -n "$(find "$p" -maxdepth 0 -user "$uid" ! -perm -020 ! -perm -002 2>/dev/null)" ] || return 1
    fi
  done
}

# release_admin DIR: the name of DIR's worktree folder in the bare clone ($REPO/worktrees/NAME, whose gitdir names
# DIR/.git), or nothing.
release_admin() {
  local w
  for w in "$REPO"/worktrees/*; do
    [ -f "$w/gitdir" ] && [ "$(cat "$w/gitdir")" = "$1/.git" ] && { basename "$w"; return 0; }
  done
  return 0
}

# release_problem DIR SHA: what makes DIR not the release of commit SHA that root may run code from, or nothing (and
# status 0) when it is: the folder of that commit under $RELEASES with no symbolic link on the way, root's and read-only
# to everyone else throughout, marked ready for SHA by root, a worktree of root's bare clone at SHA, and clean (nothing
# changed, added or ignored beyond the dependencies and the web build).
release_problem() {
  local dir=$1 sha=$2 admin gitdir bad head st
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "no full commit id was recorded for it (${sha:-none})"; return 0; }
  [ "$dir" = "$RELEASES/${sha:0:12}" ] || { echo "$dir is not $RELEASES/${sha:0:12}, the folder of ${sha:0:12}"; return 0; }
  [ -d "$dir" ] && [ ! -L "$dir" ] || { echo "$dir is not a folder"; return 0; }
  [ "$(readlink -f "$dir")" = "$dir" ] || { echo "$dir leads through a symbolic link (to $(readlink -f "$dir"))"; return 0; }
  [ "$(readlink -f "$REPO")" = "$REPO" ] || { echo "$REPO leads through a symbolic link"; return 0; }
  for bad in "$APP" "$RELEASES" "$REPO" "$dir" "$dir/.git" "$dir.ready"; do
    root_owned "$bad" || { echo "$bad is missing, not root's, or writable by others"; return 0; }
  done
  [ "$(cat "$dir.ready")" = "$sha" ] || { echo "$dir.ready does not name $sha"; return 0; }
  bad=$(find "$dir" \( ! -user "${FFF_TRUSTED_UID:-0}" -o \( ! -type l \( -perm -020 -o -perm -002 -o -perm -4000 -o -perm -2000 \) \) \) -print -quit 2>/dev/null) ||
    { echo "$dir cannot be read through"; return 0; }
  [ -z "$bad" ] || { echo "$bad is not root's, or is writable by others or setuid"; return 0; }
  # A link may lead only inside the release (node_modules/.bin has many), never to a file fff can change.
  bad=$(find "$dir" -type l -exec realpath -m -- {} + 2>/dev/null | grep -vE "^$dir(/|$)" | head -n 1) || true
  [ -z "$bad" ] || { echo "a symbolic link in $dir leads out of it, to $bad"; return 0; }
  admin=$(release_admin "$dir")
  if [ -z "$admin" ] || ! root_owned "$REPO/worktrees/$admin"; then echo "$dir is not a worktree of $REPO"; return 0; fi
  gitdir=$(cat "$dir/.git")
  [ "$gitdir" = "gitdir: $REPO/worktrees/$admin" ] || { echo "$dir/.git does not point at $REPO/worktrees/$admin"; return 0; }
  head=$(git_root -C "$dir" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null) || head=""
  [ "$head" = "$sha" ] || { echo "$dir is at ${head:-no commit}, not $sha"; return 0; }
  st=$(git_root -C "$dir" status --porcelain=v1 --ignored --untracked-files=normal 2>&1) || { echo "git status in $dir failed: $st"; return 0; }
  st=$(printf '%s\n' "$st" | grep -vxE '!! (node_modules|web/node_modules|web/dist)/' | grep . | head -n 5 | paste -sd' ' -) || true
  [ -z "$st" ] || { echo "$dir is not clean: $st"; return 0; }
}

# release_ok DIR: DIR passes release_problem for the commit its root-owned .ready names.
release_ok() {
  [ -n "$1" ] && root_owned "$1.ready" && [ -z "$(release_problem "$1" "$(cat "$1.ready")")" ]
}

# harden_release DIR SHA: after the build (fff's npm ci and web build), DIR becomes root's and read-only to everyone
# else, every tracked file is written again by root (a new file, so nothing fff opened during the build writes into it),
# its .git link is rewritten, and DIR.ready names SHA. Fails, saying why, unless release_problem then finds nothing.
harden_release() {
  local dir=$1 sha=$2 admin p
  rm -f "$dir.ready"
  chown -R -h -P root:root "$dir"
  chmod -R go-w,ug-s "$dir"
  admin=$(release_admin "$dir")
  [ -n "$admin" ] || { log "ERROR: $dir is not a worktree of $REPO"; return 1; }
  rm -f "$dir/.git"
  printf 'gitdir: %s\n' "$REPO/worktrees/$admin" >"$dir/.git"
  chmod 0644 "$dir/.git"
  git_root -C "$dir" checkout-index --force --all || { log "ERROR: could not write $dir's tracked files again"; return 1; }
  git_root -C "$dir" update-index -q --refresh >/dev/null 2>&1 || true
  p=$(writers_in "$dir")
  [ -z "$p" ] || { log "ERROR: $p still writes into $dir, opened before it became root's"; return 1; }
  printf '%s\n' "$sha" >"$dir.ready.new"
  chmod 0644 "$dir.ready.new"
  mv -f "$dir.ready.new" "$dir.ready"
  p=$(release_problem "$dir" "$sha")
  [ -z "$p" ] || { rm -f "$dir.ready"; log "ERROR: release ${sha:0:12} is not fit to run: $p"; return 1; }
}

# writers_in DIR: a process that holds a file under DIR open for writing, or mapped shared and writable, or nothing.
# Write access is checked when a file is opened, so one fff opened during the build would outlast harden_release.
writers_in() {
  local fd pid fl
  while IFS= read -r fd; do
    case $(readlink "$fd" 2>/dev/null) in *' (deleted)') continue ;; esac
    pid=${fd#/proc/}; pid=${pid%%/*}
    fl=$(sed -n 's/^flags:[[:space:]]*//p' "/proc/$pid/fdinfo/${fd##*/}" 2>/dev/null) || continue
    [ -n "$fl" ] && [ $((8#$fl & 3)) -ne 0 ] || continue
    echo "process $pid ($(cat "/proc/$pid/comm" 2>/dev/null))"
    return 0
  done < <(find /proc/[0-9]*/fd -maxdepth 1 -lname "$1/*" 2>/dev/null)
  for fd in /proc/[0-9]*/maps; do
    grep -qF " $1/" "$fd" 2>/dev/null || continue
    if awk -v d="$1/" '$2 ~ /^.w.s/ && index($6, d) == 1 { f = 1 } END { exit !f }' "$fd" 2>/dev/null; then
      pid=${fd#/proc/}; echo "process ${pid%%/*} (a shared writable mapping)"; return 0
    fi
  done
}

# own_app: $FFF_ROOT root's with fff's group and the sticky bit (1770: fff makes its own folders there, and cannot rename
# or replace $APP), $APP and $RELEASES root's (0755), and nothing in $APP left that fff made before w5505 except the
# release folders: the current and previous links made again as root's, anything else (a record, a log, a link left in
# place of one) removed, so root never writes through a symbolic link fff put there.
own_app() {
  local e t
  [ ! -L "$FFF_ROOT" ] && [ ! -L "$APP" ] || die "$FFF_ROOT or $APP is a symbolic link: not touching it"
  chown "root:$FFF_USER" "$FFF_ROOT"
  chmod 1770 "$FFF_ROOT"
  install -d -m 0755 -o root -g root "$APP" "$RELEASES"
  chown root:root "$APP" "$RELEASES"
  chmod 0755 "$APP" "$RELEASES"
  for e in "$APP"/* "$APP"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    [ "$e" != "$RELEASES" ] && [ "$e" != "$REPO" ] || continue
    root_owned "$e" && continue
    if [ "$e" = "$CURRENT" ] || [ "$e" = "$PREVIOUS" ]; then
      t=$(readlink "$e" 2>/dev/null || true)
      rm -f "$e"
      [ -z "$t" ] || ln -s "$t" "$e"
    else
      rm -rf "$e"
    fi
  done
}
