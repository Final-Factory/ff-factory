#!/usr/bin/env bash
# the fakes' bodies are single-quoted on purpose: they expand when they run
# shellcheck disable=SC2016
# fff-machine-ssh (w537): the portal's ssh aliases and pinned host keys, against fake machines. ssh-keyscan and the
# connection are faked; ssh -G and ssh-keygen are the real ones. Any machine with OpenSSH's client, no root, no network
# (lint.sh runs it; the guest install's run is in ci-vm-e2e.sh).
#
#   deploy/vm/test/fff-machine-ssh.test.sh            (from the repository root)
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
ROOT=$PWD
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0
fail() { echo "FAIL: $*"; echo "--- the last run's output:"; cat "$T/out" 2>/dev/null || true; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }
REAL_SSH=$(command -v ssh)

# Host keys: the pinned ones, and an impostor's.
for k in m3 m5 lothx beast impostor biscuit newpc kh2pc; do ssh-keygen -q -t ed25519 -N '' -C "$k" -f "$T/hk-$k"; done
pub() { cut -d' ' -f2 "$T/hk-$1.pub"; }
cat >"$T/machines.ssh" <<EOF
# alias  host  user  key
m3        m3        benryding  $(pub m3)  # a comment
m5        m5        benryding  $(pub m5)
Loth2800  Loth2800  Lothsahn   $(pub lothx)
beast     beast     rydin      $(pub beast)
EOF
# The network as this test has it: m3 and Loth2800 answer with their own keys, the m5 with an impostor's, beast not at
# all. ssh gets into the m3 and beast; Loth2800 refuses the portal's key.
mkdir -p "$T/bin"
cat >"$T/bin/ssh-keyscan" <<EOF
#!/usr/bin/env bash
h=\${!#}
case "\$h" in
  m3) echo "m3 ssh-ed25519 $(pub m3)" ;;
  m5) echo "m5 ssh-ed25519 $(pub impostor)" ;;
  loth2800) echo "loth2800 ssh-ed25519 $(pub lothx)" ;;
  biscuit) echo "biscuit ssh-ed25519 $(pub biscuit)" ;;
  newpc) echo "newpc ssh-ed25519 $(pub newpc)" ;;
  kh2pc) echo "kh2pc ssh-ed25519 $(pub kh2pc)" ;;
  *) exit 1 ;;
esac
EOF
cat >"$T/bin/ssh" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do [ "\$a" = -G ] && exec $REAL_SSH "\$@"; done
echo "ssh \$*" >>"$T/ssh-calls"
for a in "\$@"; do
  case "\$a" in
    m3 | beast | biscuit | newpc) exit 0 ;;
    Loth2800) echo "Lothsahn@loth2800: Permission denied (publickey)." >&2; exit 255 ;;
    m5) echo "Host key verification failed." >&2; exit 255 ;;
  esac
done
exit 255
EOF
# The guest script refuses root (it writes the portal account's files); CI's lint runs this as root, so it sees a uid
# of its own here.
printf '#!/bin/sh\n[ "$1" = -u ] && echo 1000 || exec /usr/bin/id "$@"\n' >"$T/bin/id"
chmod +x "$T/bin"/*
export PATH=$T/bin:$PATH HOME=$T/home
mkdir -p "$HOME/.ssh"
printf 'Host other\n  HostName other.example\n  User someone\n' >"$HOME/.ssh/config"
# A private key that must never be printed, and the earlier first-use entry for beast, hashed, with another key.
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-MARKER-w537\n-----END OPENSSH PRIVATE KEY-----\n' >"$HOME/.ssh/id_ed25519"
echo "ssh-ed25519 AAAAportalpublickey fff-portal@fff" >"$HOME/.ssh/id_ed25519.pub"
echo "beast ssh-ed25519 $(pub impostor)" >"$HOME/.ssh/known_hosts"
ssh-keygen -q -H -f "$HOME/.ssh/known_hosts" && rm -f "$HOME/.ssh/known_hosts.old"
run() { rc=0; bash "$ROOT/deploy/vm/guest/fff-machine-ssh" --data "$T/machines.ssh" "$@" >"$T/out" 2>&1 || rc=$?; }
fpr() { ssh-keygen -l -f "$T/hk-$1.pub" | awk '{print $2}'; }
pinned() { ssh-keygen -F "$1" -f "$HOME/.ssh/known_hosts" | grep -v '^#' | awk '{print $3}'; }

# 1. --check before anything: nothing written, the missing aliases and keys named, exit 1.
cp "$HOME/.ssh/config" "$T/config.before"
run --check
[ "$rc" = 1 ] || fail "1: --check exit $rc, not 1"
cmp -s "$HOME/.ssh/config" "$T/config.before" || fail "1: --check changed the config"
matches -F "m3: alias MISSING" "$T/out" || fail "1: the m3's alias is not reported missing"
matches -F "beast: alias MISSING (ssh -G gives" "$T/out" || fail "1: beast's alias"
matches -F "known_hosts: ANOTHER key ($(fpr impostor))" "$T/out" || fail "1: beast's first-use key is not reported"
ok "--check changes nothing and names what is missing"

# 2. --fix: aliases first in the config (the person's own block kept), keys pinned, the impostor refused.
run --fix
[ "$rc" = 1 ] || fail "2: --fix exit $rc, not 1 (the m5 is refused, Loth2800 refuses the key)"
[ "$(head -n 1 "$HOME/.ssh/config")" = '# >>> fff machines (written by fff-machine-ssh from machines.ssh: change it there) >>>' ] || fail "2: the managed block is not first"
matches -x 'Host other' "$HOME/.ssh/config" || fail "2: the config's own block was lost"
[ "$(stat -c %a "$HOME/.ssh/config")" = 600 ] || fail "2: the config is not 0600"
[ "$(stat -c %a "$HOME/.ssh/known_hosts")" = 600 ] || fail "2: known_hosts is not 0600"
[ "$(ssh -F "$HOME/.ssh/config" -G m3 2>/dev/null </dev/null | awk '$1 == "user" {print $2}')" = benryding ] || fail "2: the m3 alias has no user benryding"
[ "$(ssh -F "$HOME/.ssh/config" -G rydin@beast 2>/dev/null </dev/null | awk '$1 == "stricthostkeychecking" {print $2}')" = true ] || fail "2: beast is not StrictHostKeyChecking yes"
[ "$(pinned m3)" = "$(pub m3)" ] || fail "2: the m3's key is not pinned"
[ "$(pinned loth2800)" = "$(pub lothx)" ] || fail "2: Loth2800's key is not pinned (lower-case host)"
[ "$(pinned beast)" = "$(pub beast)" ] || fail "2: beast's first-use key was not replaced by the pinned one"
[ -z "$(pinned m5)" ] || fail "2: the m5's impostor key or the pinned one was written although the m5 showed another key"
matches -F "m5: REFUSED: m5 shows $(fpr impostor) over the tailnet, not the pinned $(fpr m5)" "$T/out" || fail "2: the m5 refusal is not said"
matches -F "beast: pinned $(fpr beast) for beast (no answer now" "$T/out" || fail "2: beast pinned while not answering"
matches -F "m3: alias ok; known_hosts: pinned; tailnet: $(fpr m3) = pinned; ssh: ok" "$T/out" || fail "2: the m3's check line"
matches -F "m5: alias ok; known_hosts: MISSING; tailnet: $(fpr impostor) DIFFERS from the pinned $(fpr m5); ssh: Host key verification failed." "$T/out" || fail "2: the m5's check line"
matches -F 'Loth2800: alias ok; known_hosts: pinned; tailnet:' "$T/out" || fail "2: Loth2800's check line"
matches -F 'ssh: Lothsahn@loth2800: Permission denied (publickey).' "$T/out" || fail "2: Loth2800's refusal"
matches -F 'from="<the tailnet IP of this VM>",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAAportalpublickey fff-portal@fff' "$T/out" || fail "2: no authorized_keys line for the refusing machine"
! matches -e 'SECRET-MARKER' -e 'PRIVATE KEY' "$T/out" || fail "2: the private key was printed"
ok "--fix: aliases first, keys pinned (first-use key replaced), an impostor refused, the authorized_keys line given"

# 3. --fix again: one managed block, one line per pinned host.
run --fix
[ "$(grep -c '^# >>> fff machines' "$HOME/.ssh/config")" = 1 ] || fail "3: the managed block is there twice"
[ "$(ssh-keygen -F m3 -f "$HOME/.ssh/known_hosts" | grep -vc '^#')" = 1 ] || fail "3: the m3's key is there twice"
[ ! -e "$HOME/.ssh/known_hosts.old" ] || fail "3: ssh-keygen's known_hosts.old was left"
ok "--fix again changes nothing more"

# 4. The m5 shows its pinned key again: pinned on the next --fix.
sed -i "s|m5) echo \"m5 ssh-ed25519 .*\" ;;|m5) echo \"m5 ssh-ed25519 $(pub m5)\" ;;|" "$T/bin/ssh-keyscan"
run --fix
[ "$(pinned m5)" = "$(pub m5)" ] || fail "4: the m5 is not pinned once it shows the pinned key"
ok "a machine that shows its pinned key again is pinned"

# 5. --key (w676): the portal's authorized_keys line alone, its public key only.
run --key
[ "$rc" = 0 ] || fail "5: --key exit $rc, not 0"
[ "$(cat "$T/out")" = 'from="<the tailnet IP of this VM>",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAAportalpublickey fff-portal@fff' ] ||
  fail "5: --key did not print the line alone"
ok "--key prints the portal's authorized_keys line and nothing else"

# 6. --pin (w676): a new machine's host key, read on the machine, equal to what the tailnet shows, for a host nothing
# pins yet. Every refusal writes nothing.
kh_before=$(cat "$HOME/.ssh/known_hosts")
cfg_before=$(cat "$HOME/.ssh/config")
# said RC TEXT: the last run exited RC and said TEXT.
said() { [ "$rc" = "$1" ] && matches -F "$2" "$T/out"; }
unchanged() { [ "$(cat "$HOME/.ssh/known_hosts")" = "$kh_before" ] && [ "$(cat "$HOME/.ssh/config")" = "$cfg_before" ] && [ ! -e "$HOME/.ssh/fff-pins.ssh" ]; }
run --pin ben-ryding@biscuit "$(fpr impostor)"
[ "$rc" = 1 ] || fail "6: a wrong fingerprint: exit $rc, not 1"
matches -F "biscuit: REFUSED: it shows $(fpr biscuit) over the tailnet, not $(fpr impostor) read on the machine" "$T/out" || fail "6: the mismatch is not said"
unchanged || fail "6: a refused pin wrote something"
run --pin ben-ryding@ghost "$(fpr biscuit)"
said 1 'ghost: REFUSED: no answer on port 22' || fail "6: a host that does not answer was not refused (exit $rc)"
run --pin benryding@m3 "$(fpr m3)"
said 1 'm3: REFUSED: already pinned (m3)' || fail "6: a machine of machines.ssh was pinned again (exit $rc)"
# known_hosts2: what the worker installers register (server/machineSsh.ts); a host there is not the worker's to pin.
echo "kh2pc ssh-ed25519 $(pub impostor)" >"$HOME/.ssh/known_hosts2"
run --pin someone@kh2pc "$(fpr kh2pc)"
said 1 'kh2pc: REFUSED: known_hosts or known_hosts2 already holds' || fail "6: a host in known_hosts2 was pinned (exit $rc)"
rm -f "$HOME/.ssh/known_hosts2"
for bad in "x;id@biscuit $(fpr biscuit)" "-oProxyCommand=id@biscuit $(fpr biscuit)" "biscuit $(fpr biscuit)" 'ben-ryding@biscuit SHA256:short' 'ben-ryding@biscuit ../etc/passwd'; do
  # shellcheck disable=SC2086 # the words are the arguments
  run --pin $bad
  [ "$rc" = 2 ] || fail "6: --pin $bad: exit $rc, not 2"
done
unchanged || fail "6: a refused pin wrote something"
run --pin ben-ryding@Biscuit "$(fpr biscuit)"
[ "$rc" = 0 ] || fail "6: --pin of biscuit: exit $rc, not 0"
matches -F "biscuit: pinned $(fpr biscuit) for biscuit, user ben-ryding" "$T/out" || fail "6: the pin is not said"
matches -F "biscuit: alias ok; known_hosts: pinned; tailnet: $(fpr biscuit) = pinned; ssh: ok" "$T/out" || fail "6: the pinned machine's check line"
[ "$(grep -c ': alias ' "$T/out")" = 1 ] || fail "6: --pin checked more than the machine it pinned"
[ "$(pinned biscuit)" = "$(pub biscuit)" ] || fail "6: biscuit's key is not in known_hosts"
[ "$(ssh -F "$HOME/.ssh/config" -G biscuit 2>/dev/null </dev/null | awk '$1 == "user" {print $2}')" = ben-ryding ] || fail "6: no alias biscuit with user ben-ryding"
[ "$(stat -c %a "$HOME/.ssh/fff-pins.ssh")" = 600 ] || fail "6: the pins file is not 0600"
run --pin ben-ryding@biscuit "$(fpr biscuit)"
said 1 'biscuit: REFUSED: already pinned' || fail "6: biscuit was pinned twice (exit $rc)"
run --pin someone@newpc "$(pub newpc)"
said 0 "newpc: pinned $(fpr newpc)" || fail "6: --pin with the key itself (not its fingerprint) did not pin (exit $rc)"
# The pinned machines stay through --check and --fix (machines.ssh's block is rewritten with them), once each.
run --check
matches -F "biscuit: alias ok; known_hosts: pinned" "$T/out" || fail "6: --check does not cover biscuit"
matches -F "newpc: alias ok" "$T/out" || fail "6: --check does not cover newpc"
run --fix
[ "$(ssh -F "$HOME/.ssh/config" -G biscuit 2>/dev/null </dev/null | awk '$1 == "user" {print $2}')" = ben-ryding ] || fail "6: --fix dropped biscuit's alias"
[ "$(ssh-keygen -F biscuit -f "$HOME/.ssh/known_hosts" | grep -vc '^#')" = 1 ] || fail "6: biscuit's key is not there once after --fix"
! matches -e 'SECRET-MARKER' -e 'PRIVATE KEY' "$T/out" || fail "6: the private key was printed"
ok "--pin pins a new machine's key only when the machine's own fingerprint and the tailnet agree, once, and refuses the rest unchanged"

# 7. The host's machine-ssh.sh streams this checkout's script and machines.ssh into the VM (a fake fff-vm runs the
# stream here, as the portal's account would): --check through it reports the same lines.
mkdir -p "$T/rootbin"
printf '#!/bin/sh
[ "$1" = -u ] && echo 0 || exec /usr/bin/id "$@"
' >"$T/rootbin/id"
printf '#!/usr/bin/env bash
[ "$1" = ssh ] && [ "$2" = "sudo -H -u fff bash -s" ] || exit 9
exec env PATH="%s" bash -s
' "$PATH" >"$T/fff-vm"
chmod +x "$T/rootbin/id" "$T/fff-vm"
rc=0
PATH=$T/rootbin:$PATH FFF_VM_BIN=$T/fff-vm bash "$ROOT/deploy/vm/host/machine-ssh.sh" --check >"$T/out" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "7: machine-ssh.sh --check exit $rc, not 1 (Loth2800 refuses)"
# The checkout's machines.ssh (the real pinned keys), not this test's: against this test's fake machines the m3's real
# pinned key is named as the one its key differs from.
matches -F "m3: alias ok; known_hosts: ANOTHER key ($(fpr m3)); tailnet: $(fpr m3) DIFFERS from the pinned SHA256:dNKSZKv7qWFocpDj+Fe2B2XbsPgdqDdbZ7m1dtk6H9c; ssh: ok" "$T/out" ||
  fail "7: the m3's line through the host script"
ok "the host's machine-ssh.sh runs the checkout's script and machines.ssh in the VM"

echo "fff-machine-ssh.test.sh: $PASS passed"
