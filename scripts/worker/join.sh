#!/usr/bin/env bash
# Join this Mac or Linux PC to FF Factory in one step (w1592, docs/worker-install.md "Adding a machine with a join
# code"). Run it as yourself (not sudo) on a computer connected to Tailscale, with the join code an owner got from
# add_machine join_code:
#   bash -c "$(curl -fsSL https://<the portal>/join/unix.sh)"
# The portal serves this file with its own address written in. It checks node 22.6+, git 2.48+, git-lfs and Claude Code
# (installs the missing ones with Homebrew on a Mac, and Claude Code with its own installer, on your yes), checks that
# Remote Login (sshd) is on, redeems the code (the credential goes straight into a private file, never onto the screen),
# runs the worker installer (install.sh) with it and deletes the file. Run again on an installed computer, it updates the
# install instead and needs no code.
#
# Options: --root <dir>, --max-sandboxes N, --max-agents-per-sandbox N, --max-unity N, --dry-run (change nothing, the
# code stays unused), --yes (ask nothing but the code). Tests only (scripts/worker/join.test.ts): --tailscale <fake>,
# --installer <fake install.sh>, --skip-machine-setup.
set -euo pipefail

PORTAL_URL='__FF_PORTAL_URL__'
WORKER_TAG='tag:fff-worker'
INSTALL_URL='https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh'
ROOT='' MAX_SANDBOXES='' MAX_AGENTS='' MAX_UNITY='' DRY_RUN=0 YES=0 TAILSCALE='' INSTALLER='' SKIP_SETUP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --portal-url) PORTAL_URL=$2; shift 2 ;;
    --root) ROOT=$2; shift 2 ;;
    --max-sandboxes) MAX_SANDBOXES=$2; shift 2 ;;
    --max-agents-per-sandbox) MAX_AGENTS=$2; shift 2 ;;
    --max-unity) MAX_UNITY=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) YES=1; shift ;;
    --tailscale) TAILSCALE=$2; shift 2 ;;
    --installer) INSTALLER=$2; shift 2 ;;
    --skip-machine-setup) SKIP_SETUP=1; shift ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
tty_read() { # prompt, default -> the answer on stdout
  if [ "$YES" = 1 ] || ! { true </dev/tty; } 2>/dev/null; then printf '%s' "$2"; return; fi
  local a
  read -r -p "$1${2:+ [$2]} " a </dev/tty || true
  printf '%s' "${a:-$2}"
}
yes_no() { # question, default y|n
  local a
  a=$(tty_read "$1 [$([ "$2" = y ] && echo Y/n || echo y/N)]" "$2")
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

[ "$(id -u)" = 0 ] && { say 'Run this as yourself, not with sudo.'; exit 2; }
case "$(uname -s)" in Darwin) OS=macos ;; Linux) OS=linux ;; *) say 'This is for a Mac or a Linux PC; on Windows run join.ps1.'; exit 2 ;; esac
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH

say 'FF Factory: join this computer (one step). Nothing secret is shown on screen.'
case "$PORTAL_URL" in __FF_*|'') PORTAL_URL=$(tty_read 'Portal URL (https://<portal>.<tailnet>.ts.net)' '') ;; esac
PORTAL=${PORTAL_URL%/}

# Only the folder this run makes: the credential file and the portal's answers.
WORK=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/ff-join.XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT

step 'Tailscale and the portal'
if [ -z "$TAILSCALE" ]; then
  TAILSCALE=$(command -v tailscale || true)
  [ -z "$TAILSCALE" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [ -z "$TAILSCALE" ] || ! "$TAILSCALE" status >/dev/null 2>&1; then
  say 'Tailscale is not connected on this computer. Install it (https://tailscale.com/download), sign in, then run this again.'
  exit 2
fi
TAGGED=0
"$TAILSCALE" status --json 2>/dev/null | grep -q "\"$WORKER_TAG\"" && TAGGED=1
if ! curl -fsS --max-time 15 "$PORTAL/api/health" >/dev/null 2>&1; then
  say "The portal at $PORTAL does not answer."
  exit 2
fi
say "The portal at $PORTAL answers."

# --- the tools
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' 2>/dev/null; }
git_ok() {
  local v major minor
  v=$(git --version 2>/dev/null | sed -E 's/^git version ([0-9]+)\.([0-9]+).*/\1.\2/') || return 1
  major=${v%%.*} minor=${v#*.}
  case "$major$minor" in *[!0-9]*|'') return 1 ;; esac
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 48 ]; }
}
missing_tools() {
  node_ok || echo 'node'
  git_ok || echo 'git'
  git lfs version >/dev/null 2>&1 || echo 'git-lfs'
  command -v claude >/dev/null || echo 'claude'
}
install_tools() {
  local missing
  missing=$(missing_tools | tr '\n' ' ')
  if [ -z "${missing// /}" ]; then say 'node, git, git-lfs and Claude Code: all here.'; return 0; fi
  say "Missing: $missing"
  if [ "$DRY_RUN" = 1 ]; then say "Would install: $missing"; return 0; fi
  local brewable=() t
  for t in $missing; do [ "$t" != claude ] && brewable+=("$t"); done
  if [ "${#brewable[@]}" -gt 0 ]; then
    if [ "$OS" = macos ] && command -v brew >/dev/null; then
      yes_no "Install ${brewable[*]} with Homebrew now?" y && brew install "${brewable[@]}"
    else
      say "Install ${brewable[*]} first (Linux: your package manager; Node.js 22.6+ from nodejs.org or NodeSource), then run this again."
      return 1
    fi
  fi
  case " $missing " in *' claude '*) yes_no 'Install Claude Code now (https://claude.ai/install.sh)?' y && curl -fsSL https://claude.ai/install.sh | bash ;; esac
  hash -r
  missing=$(missing_tools | tr '\n' ' ')
  if [ -n "${missing// /}" ]; then say "Still missing: $missing. Install it, then run this again."; return 1; fi
  say 'node, git, git-lfs and Claude Code: all here now.'
}
ssh_check() {
  if (exec 3<>/dev/tcp/127.0.0.1/22) 2>/dev/null; then say 'sshd: on (the portal updates this computer over it).'; return 0; fi
  if [ "$OS" = macos ]; then
    say 'Remote Login is off: turn it on in System Settings > General > Sharing > Remote Login (for your user), so the portal can update this Mac later.'
  else
    say 'No sshd answers on port 22: install and start it (Ubuntu: sudo apt install openssh-server), so the portal can update this PC later.'
  fi
  say 'Going on without it: the daemon works; only the portal''s updates over ssh wait for it.'
}

# --- an install that is already here: update it, no code
root_installed() { [ -n "$1" ] && { [ -f "$1/root.json" ] || [ -f "$1/moved.json" ]; }; }
if [ -z "$ROOT" ]; then
  for f in "$HOME/Library/LaunchAgents/com.fffactory.daemon.plist" "$HOME/.config/systemd/user/com.fffactory.daemon.service"; do
    [ -f "$f" ] || continue
    r=$(grep -oE '/[^<"[:space:]]*/daemon/app' "$f" | head -n 1 || true)
    r=${r%/daemon/app}
    root_installed "$r" && ROOT=$r
  done
fi
if root_installed "$ROOT"; then
  step "Already installed at $ROOT: updating it (no join code needed)"
  if [ "$DRY_RUN" = 1 ]; then say "Dry run: it would update the install at $ROOT (install.sh --update)."; exit 0; fi
  if [ "$SKIP_SETUP" = 0 ]; then install_tools || exit 2; ssh_check; fi
  args=(--update --root "$ROOT")
  [ -n "$MAX_SANDBOXES" ] && args+=(--max-sandboxes "$MAX_SANDBOXES")
  [ -n "$MAX_AGENTS" ] && args+=(--max-agents-per-sandbox "$MAX_AGENTS")
  [ -n "$MAX_UNITY" ] && args+=(--max-unity "$MAX_UNITY")
  if [ -n "$INSTALLER" ]; then bash "$INSTALLER" "${args[@]}"; else bash -c "$(curl -fsSL "$INSTALL_URL")" -- "${args[@]}"; fi
  exit $?
fi

# --- a new machine: the tools first (the rest reads the portal's JSON with node)
step 'Tools'
if [ "$SKIP_SETUP" = 0 ]; then install_tools || exit 2; ssh_check; fi
command -v node >/dev/null || { say 'node is needed to go on.'; exit 2; }

ROOT_GUESS=${ROOT:-$HOME/ffw}
if [ "$OS" = macos ]; then RAM=$(( $(sysctl -n hw.memsize) / 1073741824 )); else RAM=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 )); fi
CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
probe=$ROOT_GUESS; while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
FREE=$(( $(df -Pk "$probe" | awk 'NR==2 {print $4}') / 1048576 ))

if [ -n "${FF_JOIN_CODE:-}" ]; then CODE=$FF_JOIN_CODE; else CODE=$(tty_read 'Join code (from the owner who added this computer):' ''); fi
CODE=$(printf '%s' "$CODE" | tr -cd 'A-Za-z0-9-')
body() { # check(true|false) -> the request body
  printf '{"code":"%s","check":%s,"facts":{"os":"%s","ramGB":%s,"cpus":%s,"freeGB":%s}}' "$CODE" "$1" "$OS" "$RAM" "$CPUS" "$FREE"
}
post_join() { # check, out file -> HTTP status
  curl -sS --max-time 60 -o "$2" -w '%{http_code}' -H 'content-type: application/json' --data "$(body "$1")" "$PORTAL/machine/join"
}
json() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],j);process.stdout.write(v==null?"":String(v))' "$1" "$2"; }

status=$(post_join true "$WORK/check.json" 2>/dev/null || true)
[ "$status" = 200 ] || { say "The portal refused the code: $(json "$WORK/check.json" error 2>/dev/null || echo "HTTP $status")"; exit 2; }
ID=$(json "$WORK/check.json" machineId)
LS=${MAX_SANDBOXES:-$(json "$WORK/check.json" limits.maxSandboxes)}
LA=${MAX_AGENTS:-$(json "$WORK/check.json" limits.maxAgentsPerSandbox)}
LU=${MAX_UNITY:-$(json "$WORK/check.json" limits.maxUnity)}
say "The code is good: this computer joins as '$ID' (code valid until $(json "$WORK/check.json" expiresAt))."
say "Limits: $LS sandboxes, $LA agents per sandbox, $LU Unity editors at once ($(json "$WORK/check.json" defaultsWhy))."
ROOT=${ROOT:-$(tty_read 'Root folder (an empty or new folder with 200+ GB free)' "$ROOT_GUESS")}
say "Root: $ROOT."
if [ "$DRY_RUN" = 1 ]; then say 'Dry run: nothing was changed, and the code is still unused. Run it again without --dry-run to join.'; exit 0; fi
yes_no 'Go on: enrol and install this computer?' y || { say 'Stopped; nothing was changed and the code is still unused.'; exit 1; }

step 'Enrolling'
status=$(post_join false "$WORK/join.json" 2>/dev/null || true)
CODE=''
[ "$status" = 200 ] || { say "The portal refused the join: $(json "$WORK/join.json" error 2>/dev/null || echo "HTTP $status")"; exit 2; }
CRED="$WORK/machine-credential"
# The credential goes from the answer into its own 0600 file, and the answer loses it, without passing the screen.
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],j.credential+"\n",{mode:0o600});delete j.credential;fs.writeFileSync(process.argv[1],JSON.stringify(j))' "$WORK/join.json" "$CRED"
say "The portal made the record for '$ID' and issued its credential (...$(json "$WORK/join.json" last4)), written to a private file for the installer."

step 'Installing (install.sh)'
args=(--root "$ROOT" --portal-url "$PORTAL" --max-sandboxes "$LS" --max-agents-per-sandbox "$LA" --max-unity "$LU" --credential-file "$CRED")
rc=0
if [ -n "$INSTALLER" ]; then bash "$INSTALLER" "${args[@]}" || rc=$?; else bash -c "$(curl -fsSL "$INSTALL_URL")" -- "${args[@]}" || rc=$?; fi
rm -f "$CRED"
say "The credential file is deleted$([ -e "$CRED" ] && echo " (NOT: remove $CRED by hand)")."

step 'Summary'
say "- Machine: $ID, root $ROOT."
if [ "$rc" = 0 ]; then say '- Installer: finished; its report is above. list_machines shows the machine.'; else say "- Installer: stopped (exit $rc); its report is above. Fix that and run this again."; fi
[ "$TAGGED" = 1 ] || say "- The portal's ssh reaches this computer only if the tailnet policy's tcp:22 grant covers it: a tailnet admin tags it $WORKER_TAG (admin console > Machines > Edit ACL tags) or names it in that grant (docs/worker-install.md, 'The tailnet')."
say '- No credential was shown or kept outside the install (its own secrets folder).'
exit "$rc"
