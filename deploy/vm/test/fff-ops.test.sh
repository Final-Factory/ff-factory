#!/usr/bin/env bash
# The orchestration worker's VM scripts (w597, docs/ops-worker.md), against fakes, no root and no VM: run by lint.sh.
#   fff-ops-launch: the header's arguments reach claude, the environment is rebuilt from nothing, the credential comes on
#                   fd 3 and is in no environment, a version mismatch or a missing credential answers ERR.
#   fff-ops-ssh:    a machine or user@host only; no ssh option passes through; its own options are fixed.
#   fff-ops-priv:   anything but its subcommands is refused before it does anything.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ---- fff-ops-launch, with a fake claude that prints what it got
lib=$tmp/lib
root=$tmp/ops
mkdir -p "$lib" "$root"
cat >"$lib/claude" <<'EOF'
#!/bin/bash
printf 'ARGS:'; printf ' [%s]' "$@"; echo
env | sort | sed 's/^/ENV:/'
printf 'FD3:%s\n' "$(cat <&3 2>/dev/null || echo none)"
printf 'PWD:%s\n' "$PWD"
IFS= read -r line && printf 'STDIN:%s\n' "$line"
EOF
chmod +x "$lib/claude"
echo 0.3.284 >"$lib/claude.version"
token="sk-ant-oat01-$(printf 'T%.0s' {1..60})"
header=$(jq -cn --arg t "$token" '{v: 1, sdkVersion: "0.3.284", args: ["--output-format", "stream-json", "--append-system-prompt", "two\nlines with spaces"], env: {CLAUDE_CODE_OAUTH_TOKEN: $t, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", ANTHROPIC_MODEL: "opus", FFSB_CONFIG: "/srv/fff/config/config.json", LD_PRELOAD: "/x.so", BASH_ENV: "/x", CLAUDE_CONFIG_DIR: "/srv/fff/home/.claude", PATH: "/evil"}}')
out=$(printf '%s\n{"type":"user"}\n' "$header" | OPS_LIB=$lib OPS_ROOT=$root bash $G/fff-ops-launch 2>"$tmp/err")
printf '%s\n' "$out" | head -n 1 | matches -x OK || fail "launch: no OK first: $out $(cat "$tmp/err")"
printf '%s\n' "$out" | matches -F 'ARGS: [--output-format] [stream-json] [--append-system-prompt] [two' || fail "launch: the arguments did not reach claude whole: $out"
printf '%s\n' "$out" | matches -x 'ENV:CLAUDE_CODE_ENTRYPOINT=sdk-ts' || fail "launch: Claude Code's own settings are dropped"
printf '%s\n' "$out" | matches -x 'ENV:ANTHROPIC_MODEL=opus' || fail "launch: ANTHROPIC_ settings are dropped"
printf '%s\n' "$out" | matches -x 'ENV:CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3' || fail "launch: the credential does not come on fd 3"
printf '%s\n' "$out" | matches -x "FD3:$token" || fail "launch: fd 3 does not hold the credential"
printf '%s\n' "$out" | matches -x 'STDIN:{"type":"user"}' || fail "launch: the stream after the header did not reach claude"
printf '%s\n' "$out" | matches -x "PWD:$root/scratch" || fail "launch: claude does not start in its scratch folder"
printf '%s\n' "$out" | matches -x "ENV:CLAUDE_CONFIG_DIR=$root/home/.claude" || fail "launch: CLAUDE_CONFIG_DIR is not its own"
printf '%s\n' "$out" | matches -x 'ENV:PATH=/usr/local/lib/fff/ops-bin:/usr/bin:/bin' || fail "launch: PATH is not its own"
for bad in "ENV:.*$token" 'ENV:FFSB_CONFIG' 'ENV:LD_PRELOAD' 'ENV:BASH_ENV' 'ENV:CLAUDE_CODE_OAUTH_TOKEN='; do
  if printf '%s\n' "$out" | matches -E "^$bad"; then fail "launch: the environment has ${bad#ENV:}"; fi
done
echo "ok: fff-ops-launch hands claude its arguments, its own environment and the credential on fd 3 only"
out=$(jq -cn '{v: 1, sdkVersion: "0.9.0", args: [], env: {CLAUDE_CODE_OAUTH_TOKEN: "x"}}' | OPS_LIB=$lib OPS_ROOT=$root bash $G/fff-ops-launch 2>/dev/null || true)
printf '%s' "$out" | matches '^ERR .*0.3.284.*0.9.0' || fail "launch: a version mismatch is not refused: $out"
out=$(jq -cn '{v: 1, sdkVersion: "0.3.284", args: [], env: {}}' | OPS_LIB=$lib OPS_ROOT=$root bash $G/fff-ops-launch 2>/dev/null || true)
printf '%s' "$out" | matches '^ERR .*no Claude credential' || fail "launch: no credential is not refused: $out"
out=$(echo 'not json' | OPS_LIB=$lib OPS_ROOT=$root bash $G/fff-ops-launch 2>/dev/null || true)
printf '%s' "$out" | matches '^ERR ' || fail "launch: a bad header is not refused: $out"
echo "ok: fff-ops-launch refuses another version, no credential and a bad header, with ERR and why"

# ---- fff-ops-ssh, with a fake ssh that prints its arguments
cat >"$tmp/ssh" <<'EOF'
#!/bin/sh
printf '[%s]' "$@"; echo
EOF
chmod +x "$tmp/ssh"
sshw() { FFF_OPS_SSH_USER=$(id -un) FFF_OPS_SSH_BIN=$tmp/ssh bash $G/fff-ops-ssh "$@"; }
out=$(sshw m5 whoami)
printf '%s' "$out" | matches -F '[-o][StrictHostKeyChecking=yes]' || fail "ssh: pinned host keys are not required: $out"
printf '%s' "$out" | matches -F '[-o][ProxyCommand=none]' || fail "ssh: ProxyCommand is not off: $out"
printf '%s' "$out" | matches -F '[--][m5][whoami]' || fail "ssh: the machine and command are not last: $out"
sshw rydin@beast.tail1234.ts.net hostname >/dev/null || fail "ssh: user@host is refused"
for bad in -oProxyCommand=sh -F/tmp/x '-o' 'm5;id' 'm5 x' '' '@m5' 'a@-b'; do
  if sshw "$bad" whoami >/dev/null 2>&1; then fail "ssh: '$bad' was taken as a machine"; fi
done
if FFF_OPS_SSH_USER=nobody-else FFF_OPS_SSH_BIN=$tmp/ssh bash $G/fff-ops-ssh m5 whoami >/dev/null 2>&1; then fail "ssh: runs as another account than the portal's"; fi
echo "ok: fff-ops-ssh takes a machine or user@host, never an ssh option, and fixes its own"

# ---- fff-ops-priv refuses what is not its own (before anything else: it needs root for the rest)
if [ "$(id -u)" -ne 0 ]; then
  out=$(bash $G/fff-ops-priv status 2>&1 || true)
  printf '%s' "$out" | matches 'run through sudo' || fail "priv: runs without root: $out"
fi
for sub in update restart rollback configure vault migrate backup claude-token gh-login prepare-shutdown; do
  matches -E "^  $sub\)" $G/fff-ops-priv && fail "priv: has a $sub subcommand"
done
echo "ok: fff-ops-priv has no update, restart, rollback, configure, vault, migrate, backup or token subcommand"
