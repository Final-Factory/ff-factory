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
for k in m3 m5 lothx beast impostor; do ssh-keygen -q -t ed25519 -N '' -C "$k" -f "$T/hk-$k"; done
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
  *) exit 1 ;;
esac
EOF
cat >"$T/bin/ssh" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do [ "\$a" = -G ] && exec $REAL_SSH "\$@"; done
echo "ssh \$*" >>"$T/ssh-calls"
for a in "\$@"; do
  case "\$a" in
    m3 | beast) exit 0 ;;
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

# 5. The host's machine-ssh.sh streams this checkout's script and machines.ssh into the VM (a fake fff-vm runs the
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
[ "$rc" = 1 ] || fail "5: machine-ssh.sh --check exit $rc, not 1 (Loth2800 refuses)"
# The checkout's machines.ssh (the real pinned keys), not this test's: against this test's fake machines the m3's real
# pinned key is named as the one its key differs from.
matches -F "m3: alias ok; known_hosts: ANOTHER key ($(fpr m3)); tailnet: $(fpr m3) DIFFERS from the pinned SHA256:dNKSZKv7qWFocpDj+Fe2B2XbsPgdqDdbZ7m1dtk6H9c; ssh: ok" "$T/out" ||
  fail "5: the m3's line through the host script"
ok "the host's machine-ssh.sh runs the checkout's script and machines.ssh in the VM"

echo "fff-machine-ssh.test.sh: $PASS passed"
