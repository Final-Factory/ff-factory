#!/usr/bin/env bash
# the fixed strings matched in fff-ops-priv are single-quoted on purpose
# shellcheck disable=SC2016
# The orchestration worker's VM scripts (w597, docs/ops-worker.md), against fakes, no root and no VM: run by lint.sh.
#   fff-ops-launch: the header's arguments reach claude, the environment is rebuilt from nothing, the credential comes on
#                   fd 3 and is in no environment, a version mismatch or a missing credential answers ERR.
#   fff-ops-ssh:    a machine or user@host only; no ssh option passes through; its own options are fixed.
#   scp and sftp:   real copies both ways (w612) through fff-ops-scp-ssh and fff-ops-ssh to a fake machine that runs a
#                   real sftp-server; ssh options, another port and a command that is not a copy are refused.
#   fff-ops-priv:   anything but its subcommands is refused before it does anything; machine-ssh passes only --check,
#                   --key and --pin (w676), units only itself and --check (w743), and a credential needs the machine's
#                   record (as root only).
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
out=$(sshw --sftp rydin@beast)
printf '%s' "$out" | matches -F '[-o][StrictHostKeyChecking=yes]' || fail "ssh --sftp: pinned host keys are not required: $out"
printf '%s' "$out" | matches -F '[-s][--][rydin@beast][sftp]' || fail "ssh --sftp: not the sftp subsystem of the machine: $out"
for bad in '--sftp' '--sftp m5 rm' '--sftp -oProxyCommand=sh'; do
  # shellcheck disable=SC2086 # the words are the arguments
  if sshw $bad >/dev/null 2>&1; then fail "ssh: '$bad' was taken"; fi
done
echo "ok: fff-ops-ssh --sftp opens only the machine's sftp subsystem, with the same fixed options"

# ---- scp and sftp (w612): real copies through ops-bin/scp, ops-bin/sftp, fff-ops-scp-ssh and fff-ops-ssh, to a fake
# machine: the fake ssh runs a real sftp-server (or scp's own sink and source, scp -O) in a folder of its own.
sftp_server=""
for f in /usr/lib/openssh/sftp-server /usr/libexec/sftp-server /usr/libexec/openssh/sftp-server; do [ -x "$f" ] && { sftp_server=$f; break; }; done
if [ -z "$sftp_server" ] || [ ! -x /usr/bin/scp ] || [ ! -x /usr/bin/sftp ]; then
  [ -z "${CI:-}" ] || fail "scp: no sftp-server, /usr/bin/scp or /usr/bin/sftp on this runner"
  echo "SKIP: scp and sftp (no sftp-server here)"
else
  here=$PWD
  remote=$tmp/machine
  local_=$tmp/scratch
  mkdir -p "$remote" "$local_"
  cat >"$tmp/machine-ssh" <<MACHINE
#!/bin/bash
sub=0
while [ \$# -gt 0 ]; do case \$1 in -s) sub=1; shift ;; --) shift; break ;; -o | -e) shift 2 ;; *) shift ;; esac; done
echo "\$1" >>"$tmp/machine.log"
shift
cd "$remote"
if [ \$sub = 1 ]; then exec "$sftp_server"; else exec sh -c "\$1"; fi
MACHINE
  cat >"$tmp/ops-ssh" <<OPSSSH
#!/bin/sh
FFF_OPS_SSH_USER=\$(id -un) FFF_OPS_SSH_BIN=$tmp/machine-ssh exec bash $here/$G/fff-ops-ssh "\$@"
OPSSSH
  chmod +x "$tmp/machine-ssh" "$tmp/ops-ssh"
  # ops scp|sftp ARGS...: the worker's own wrapper, in its scratch folder.
  ops() { (cd "$local_" && FFF_OPS_SCP_SSH=$here/$G/fff-ops-scp-ssh FFF_OPS_SSH_WRAPPER=$tmp/ops-ssh sh "$here/$G/ops-bin/$1" "${@:2}"); }
  echo up >"$local_/up.txt"
  echo down >"$remote/down.txt"
  ops scp up.txt m5:up.txt 2>"$tmp/err" || fail "scp: a copy to the machine failed: $(cat "$tmp/err")"
  [ "$(cat "$remote/up.txt" 2>/dev/null)" = up ] || fail "scp: the file did not reach the machine"
  matches -x m5 "$tmp/machine.log" || fail "scp: did not go to m5: $(cat "$tmp/machine.log")"
  ops scp rydin@beast:down.txt ./ 2>"$tmp/err" || fail "scp: a copy from the machine failed: $(cat "$tmp/err")"
  [ "$(cat "$local_/down.txt" 2>/dev/null)" = down ] || fail "scp: the file did not come back from the machine"
  matches -x rydin@beast "$tmp/machine.log" || fail "scp: the user@host did not reach fff-ops-ssh: $(cat "$tmp/machine.log")"
  ops scp -O up.txt m5:legacy.txt 2>"$tmp/err" || fail "scp -O: a legacy copy failed: $(cat "$tmp/err")"
  [ "$(cat "$remote/legacy.txt" 2>/dev/null)" = up ] || fail "scp -O: the file did not reach the machine"
  printf 'put up.txt sftp.txt\nget down.txt sftp-down.txt\n' >"$local_/batch"
  ops sftp -b batch m3 >/dev/null 2>"$tmp/err" || fail "sftp: a batch failed: $(cat "$tmp/err")"
  [ "$(cat "$remote/sftp.txt" 2>/dev/null)" = up ] && [ "$(cat "$local_/sftp-down.txt" 2>/dev/null)" = down ] || fail "sftp: put or get did not copy"
  echo "ok: scp both ways (sftp and scp -O) and sftp reach the machine through fff-ops-ssh"
  : >"$tmp/machine.log"
  for bad in '-o ProxyCommand=sh' '-oProxyJump=evil' '-F /tmp/cfg' '-i /tmp/key' '-J evil' '-P 2222' '-c aes128-ctr'; do
    # shellcheck disable=SC2086 # the words are scp's options
    if ops scp $bad up.txt m5:bad.txt >/dev/null 2>&1; then fail "scp: '$bad' was taken"; fi
  done
  if ops scp up.txt 'evil host:bad.txt' >/dev/null 2>&1; then fail "scp: a host with a space was taken"; fi
  [ ! -e "$remote/bad.txt" ] || fail "scp: a refused copy reached the machine"
  [ ! -s "$tmp/machine.log" ] || fail "scp: a refused copy reached ssh: $(cat "$tmp/machine.log")"
  for bad in '-- m5 rm -rf /' '-- m5 id' '-s -- m5 shell' '-oProxyCommand=sh -- m5 sftp' '-l x;id -- m5 sftp'; do
    # shellcheck disable=SC2086 # the words are the arguments scp would give its ssh
    if FFF_OPS_SSH_WRAPPER=$tmp/ops-ssh bash $G/fff-ops-scp-ssh $bad >/dev/null 2>&1; then fail "fff-ops-scp-ssh: '$bad' was taken"; fi
  done
  echo "ok: scp's ssh options, another port, a bad host and a command that is not a copy are refused before ssh"
fi

# ---- fff-ops-priv refuses what is not its own (before anything else: it needs root for the rest)
if [ "$(id -u)" -ne 0 ]; then
  out=$(bash $G/fff-ops-priv status 2>&1 || true)
  printf '%s' "$out" | matches 'run through sudo' || fail "priv: runs without root: $out"
fi
for sub in restart rollback configure vault migrate backup claude-token gh-login prepare-shutdown; do
  matches -E "^  $sub\)" $G/fff-ops-priv && fail "priv: has a $sub subcommand"
done
matches -F 'grant=$DATA/ops-deploy.grant' $G/fff-ops-priv || fail "priv: update does not need the portal's deploy grant"
matches -F '"$FFFCTL" update --no-wait' $G/fff-ops-priv || fail "priv: update is not the plain fffctl update"
echo "ok: fff-ops-priv has no restart, rollback, configure, vault, migrate, backup or token subcommand, and update needs a grant"

# ---- fff-ops-priv machine-ssh and the credential's record check (w676), for real, as root (CI's lint runs as root):
# a lib folder of fakes (lib.sh, fff-machine-ssh, fff-ops-ssh) and the portal's account taken as root.
if [ "$(id -u)" -ne 0 ]; then
  [ -z "${CI:-}" ] || fail "priv: CI runs this as root (sudo lint.sh)"
  echo "SKIP: fff-ops-priv machine-ssh (needs root)"
else
  plib=$tmp/plib
  mkdir -p "$plib" "$tmp/fffroot/data"
  printf 'load_conf() { FFF_USER=root FFF_ROOT=%s DATA=%s/data; }\n' "$tmp/fffroot" "$tmp/fffroot" >"$plib/lib.sh"
  printf '#!/bin/sh\nprintf "MSSH HOME=%%s:" "$HOME"; printf " [%%s]" "$@"; echo\n' >"$plib/fff-machine-ssh"
  printf '#!/bin/sh\necho Linux\n' >"$plib/fff-ops-ssh"
  chmod +x "$plib/fff-machine-ssh" "$plib/fff-ops-ssh"
  priv() { FFF_LIB=$plib bash $G/fff-ops-priv "$@" 2>&1; }
  [ "$(priv machine-ssh --check)" = "MSSH HOME=$tmp/fffroot/home: [--check]" ] || fail "priv: machine-ssh --check: $(priv machine-ssh --check)"
  [ "$(priv machine-ssh-check)" = "MSSH HOME=$tmp/fffroot/home: [--check]" ] || fail "priv: machine-ssh-check is not --check"
  [ "$(priv machine-ssh --key)" = "MSSH HOME=$tmp/fffroot/home: [--key]" ] || fail "priv: machine-ssh --key"
  out=$(priv machine-ssh --pin ben-ryding@biscuit SHA256:NrEQJtYSu4zczf0cdPDevBiTfH8XTtiDdkoVIH9zZvQ)
  [ "$out" = "MSSH HOME=$tmp/fffroot/home: [--pin] [ben-ryding@biscuit] [SHA256:NrEQJtYSu4zczf0cdPDevBiTfH8XTtiDdkoVIH9zZvQ]" ] || fail "priv: machine-ssh --pin: $out"
  # The person's: --fix (machines.ssh's, at a deploy), --data (a file of the worker's would be pinned), anything else.
  for bad in 'machine-ssh --fix' 'machine-ssh --data /srv/fff-ops/scratch/m.ssh --check' 'machine-ssh --check --data /tmp/x' 'machine-ssh' \
    'machine-ssh --pin ben@biscuit' 'machine-ssh --pin ben@biscuit SHA256:x --data /tmp/x' 'machine-ssh-check --fix'; do
    # shellcheck disable=SC2086 # the words are the arguments
    out=$(priv $bad || true)
    if printf '%s' "$out" | matches MSSH; then fail "priv: '$bad' reached fff-machine-ssh: $out"; fi
  done
  # credential issue: refused for a machine the portal has no record of, after ssh reached it and before anything is
  # issued (the person's add_machine worker_install comes first); with the record it goes on to issue (fffctl, absent here).
  echo '{"machines": [{"id": "m5"}]}' >"$tmp/fffroot/data/state.json"
  out=$(priv credential issue Biscuit --to ben-ryding@biscuit || true)
  printf '%s' "$out" | matches -F "the portal has no machine record 'biscuit'" || fail "priv: a credential for a machine with no record: $out"
  echo '{"machines": [{"id": "m5"}, {"id": "biscuit"}]}' >"$tmp/fffroot/data/state.json"
  out=$(priv credential issue Biscuit --to ben-ryding@biscuit || true)
  if printf '%s' "$out" | matches 'no machine record'; then fail "priv: a machine with a record was refused: $out"; fi
  printf '%s' "$out" | matches 'machine-credential issue Biscuit failed' || fail "priv: with its record, the issue did not go on: $out"
  # A credential that is issued and stored ends with exit 0 and no shell error (w734: the EXIT trap read the function's
  # local $tmp under `set -u` and the script exited 1 "tmp: unbound variable" after storing the credential).
  printf '#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = --out ] && out=$2; shift; done\necho secret >"$out"\necho "machine credential issued: $out (0600)"\n' >"$plib/fffctl"
  chmod +x "$plib/fffctl"
  rc=0
  out=$(FFFCTL=$plib/fffctl FFF_LIB=$plib bash $G/fff-ops-priv credential issue biscuit --to ben-ryding@biscuit 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || fail "priv: an issued credential ended with exit $rc: $out"
  if printf '%s' "$out" | matches 'unbound variable'; then fail "priv: the credential issue left a shell error: $out"; fi
  if printf '%s' "$out" | matches -F secret; then fail "priv: the credential was printed: $out"; fi
  echo "ok: fff-ops-priv machine-ssh runs --check, --key and --pin as the portal's account, refuses --fix and --data, and a credential needs a record and ends cleanly"
  # units and units --check (w743): exactly these two reach fffctl, and --check's exit status (1: a unit is down) comes back.
  printf '#!/bin/sh\nprintf "FFFCTL"; printf " [%%s]" "$@"; echo\n[ -z "${FAKE_UNITS_DOWN:-}" ] || { echo "down: fff-portal.service=failed"; exit 1; }\n' >"$plib/units-fffctl"
  chmod +x "$plib/units-fffctl"
  upriv() { FFFCTL=$plib/units-fffctl FFF_LIB=$plib bash $G/fff-ops-priv "$@" 2>&1; }
  [ "$(upriv units)" = "FFFCTL [units]" ] || fail "priv: units: $(upriv units)"
  [ "$(upriv units --check)" = "FFFCTL [units] [--check]" ] || fail "priv: units --check: $(upriv units --check)"
  rc=0
  out=$(FAKE_UNITS_DOWN=1 upriv units --check) || rc=$?
  [ "$rc" -eq 1 ] || fail "priv: units --check with a unit down exited $rc, not 1: $out"
  printf '%s' "$out" | matches -F 'down: fff-portal.service=failed' || fail "priv: units --check did not pass on the down line: $out"
  for bad in 'units --fix' 'units --check extra' 'units extra' 'units --check --check' 'units -- --check' 'units --pause' 'units watchdog' 'units --check; id' \
    'watchdog' 'watchdog run' 'watchdog pause' 'watchdog resume' 'watchdog reset' 'watchdog reset fff-portal.service' 'restart' 'unit' 'Units' 'units-check'; do
    rc=0
    # shellcheck disable=SC2086 # the words are the arguments
    out=$(upriv $bad) || rc=$?
    [ "$rc" -eq 2 ] || fail "priv: '$bad' was not refused (exit $rc): $out"
    if printf '%s' "$out" | matches FFFCTL; then fail "priv: '$bad' reached fffctl: $out"; fi
  done
  rc=0; out=$(upriv units '') || rc=$?
  [ "$rc" -eq 2 ] || fail "priv: units with an empty word was not refused (exit $rc): $out"
  echo "ok: fff-ops-priv units and units --check reach fffctl (and its exit status comes back); every other word, the watchdog included, is refused"
  # The other read-only forms (w745): the vault's list, list --names and help, machine-credential list, migrate --help. Every
  # other form of those commands changes the vault, a credential or the migration, or copies the key: refused, never run.
  [ "$(upriv vault list)" = "FFFCTL [vault] [list]" ] || fail "priv: vault list: $(upriv vault list)"
  [ "$(upriv vault list --names)" = "FFFCTL [vault] [list] [--names]" ] || fail "priv: vault list --names: $(upriv vault list --names)"
  [ "$(upriv vault help)" = "FFFCTL [vault] [help]" ] || fail "priv: vault help: $(upriv vault help)"
  [ "$(upriv machine-credential list)" = "FFFCTL [machine-credential] [list]" ] || fail "priv: machine-credential list: $(upriv machine-credential list)"
  [ "$(upriv migrate --help)" = "FFFCTL [migrate] [--help]" ] || fail "priv: migrate --help: $(upriv migrate --help)"
  for bad in 'vault' 'vault list extra' 'vault list --names extra' 'vault list --file x' 'vault list --stdin' 'vault help extra' 'vault get x' 'vault show x' 'vault status' \
    'vault init' 'vault init --new-key' 'vault export-key --out /tmp/k' 'vault new-key /tmp/k' 'vault add --name x --kind claude --stdin' 'vault put --name x --kind claude --stdin' \
    'vault rotate x --stdin' 'vault grant x --disable' 'vault remove x' 'vault --help' 'vault -h' 'vault LIST' \
    'machine-credential' 'machine-credential list extra' 'machine-credential issue m5 --out /tmp/c' 'machine-credential revoke m5' \
    'migrate' 'migrate --key' 'migrate --dry-run-copy' 'migrate --rollback-dry-run' 'migrate --cut-over' 'migrate --help --cut-over' 'migrate -h' 'migrate --cut-over --help'; do
    rc=0
    # shellcheck disable=SC2086 # the words are the arguments
    out=$(upriv $bad) || rc=$?
    [ "$rc" -eq 2 ] || fail "priv: '$bad' was not refused (exit $rc): $out"
    if printf '%s' "$out" | matches FFFCTL; then fail "priv: '$bad' reached fffctl: $out"; fi
  done
  echo "ok: fff-ops-priv passes vault list [--names], vault help, machine-credential list and migrate --help to fffctl, and refuses every other vault, machine-credential and migrate form"
fi
