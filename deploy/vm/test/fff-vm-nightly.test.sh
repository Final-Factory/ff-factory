#!/usr/bin/env bash
# the fakes' bodies are single-quoted on purpose: they expand when they run
# shellcheck disable=SC2016
# fff-vm nightly applying fff-vm.conf's size to the domain (w537), against a fake libvirt: what it applies, what it
# refuses, and how it goes back when the VM does not come up. Any machine, no root, no libvirt (lint.sh runs it; the real
# thing runs in ci-vm-e2e.sh). Needs bash, jq and GNU coreutils, sed and awk.
#
#   deploy/vm/test/fff-vm-nightly.test.sh            (from the repository root)
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
ROOT=$PWD
command -v jq >/dev/null || { echo "fff-vm-nightly.test.sh needs jq"; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0
fail() { echo "FAIL: $*"; echo "--- the last run's output:"; cat "$T/out" 2>/dev/null || true; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $*"; }
matches() { grep "$@" >/dev/null; }

# ---------------------------------------------------------------- the fakes
mkdir -p "$T/bin" "$T/fake"
# virsh, as libvirt answers the calls fff-vm makes. The domain's state, its definition (persistent.xml, as libvirt keeps
# it: a uuid, the memory in KiB) and the running one (live.xml). Like libvirt: a definition without the domain's uuid is
# refused; more vCPUs than FAKE_MAX_VCPUS are refused at define; more memory than FAKE_HOST_MB fails at start.
cat >"$T/bin/virsh" <<'EOF'
#!/usr/bin/env bash
set -o errexit -o nounset -o pipefail
D=$FAKE_DIR
[ "${1:-}" != --connect ] || shift 2
cmd=$1
shift
echo "$cmd $*" >>"$D/calls"
st=$(cat "$D/state")
mib() { awk -F"[<>]" '$2 ~ /^memory( |$)/ {print int($3 / 1024)}' "$1"; }
case "$cmd" in
  domstate) echo "$st"; echo ;;
  dominfo) printf 'Name:           fff-portal\nAutostart:      enable\n' ;;
  domuuid) cat "$D/uuid"; echo ;;
  dumpxml)
    if [ "${1:-}" = --inactive ] || [ "$st" != running ]; then cat "$D/persistent.xml"; else cat "$D/live.xml"; fi ;;
  define)
    f=$1
    u=$(sed -n 's|.*<uuid>\(.*\)</uuid>.*|\1|p' "$f")
    if [ "$u" != "$(cat "$D/uuid")" ]; then
      echo "error: Failed to define domain from $f" >&2
      echo "error: operation failed: domain 'fff-portal' already exists with uuid $(cat "$D/uuid")" >&2
      exit 1
    fi
    c=$(sed -n 's|.*<vcpu[^>]*>\([0-9]*\)</vcpu>.*|\1|p' "$f")
    if [ "$c" -gt "${FAKE_MAX_VCPUS:-64}" ]; then
      echo "error: Failed to define domain from $f" >&2
      echo "error: unsupported configuration: Maximum CPUs greater than specified machine type limit ${FAKE_MAX_VCPUS:-64}" >&2
      exit 1
    fi
    # As libvirt keeps it: KiB.
    awk -F"[<>]" '{
      if ($2 ~ /^(memory|currentMemory) unit=.MiB./) { sub(/>[0-9]+</, ">" $3 * 1024 "<"); sub(/MiB/, "KiB") }
      print }' "$f" >"$D/persistent.xml"
    echo "Domain 'fff-portal' defined from $f" ;;
  start)
    [ "$st" = "shut off" ] || { echo "error: Requested operation is not valid: domain is already running" >&2; exit 1; }
    if [ "$(mib "$D/persistent.xml")" -gt "${FAKE_HOST_MB:-16384}" ]; then
      echo "error: Failed to start domain 'fff-portal'" >&2
      echo "error: internal error: QEMU unexpectedly closed the monitor: Cannot allocate memory" >&2
      exit 1
    fi
    cp "$D/persistent.xml" "$D/live.xml"
    echo running >"$D/state"
    echo $(($(cat "$D/boots") + 1)) >"$D/boots"
    echo "Domain 'fff-portal' started" ;;
  shutdown | destroy) [ "$st" = running ] || exit 1; echo "shut off" >"$D/state" ;;
  qemu-agent-command)
    [ "$st" = running ] || exit 1
    case "$1" in
      # fffctl prepare-shutdown (pid 7) drains; the if-required check for /run/reboot-required (pid 8) finds none.
      *guest-exec-status*'"pid":8'*) echo '{"return":{"exited":true,"exitcode":1}}' ;;
      *guest-exec-status*) printf '{"return":{"exited":true,"exitcode":0,"out-data":"%s"}}\n' "$(printf 'drained' | base64)" ;;
      *guest-exec*'"/bin/sh"'*) echo '{"return":{"pid":8}}' ;;
      *guest-exec*) echo '{"return":{"pid":7}}' ;;
      *) echo '{"return":{}}' ;;
    esac ;;
  *) echo "fake virsh: $cmd is not faked" >&2; exit 1 ;;
esac
EOF
# curl: the portal's /api/health answers while the VM runs with at least FAKE_PORTAL_MIN_MB; nothing else answers.
cat >"$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
case "$*" in
  */api/health*)
    [ "$(cat "$D/state")" = running ] || exit 7
    m=$(awk -F"[<>]" '$2 ~ /^memory( |$)/ {print int($3 / 1024)}' "$D/live.xml")
    [ "$m" -ge "${FAKE_PORTAL_MIN_MB:-1024}" ] || exit 7
    echo '{"ok":true}' ;;
  *) exit 7 ;;
esac
EOF
# qemu-img: the qcow2's snapshots, a list.
cat >"$T/bin/qemu-img" <<'EOF'
#!/usr/bin/env bash
D=$FAKE_DIR
touch "$D/snaps"
case "$2" in
  -c) echo "$3" >>"$D/snaps" ;;
  -d) grep -vxF "$3" "$D/snaps" >"$D/snaps.new" || true; mv "$D/snaps.new" "$D/snaps" ;;
  -l) printf 'Snapshot list:\nID TAG VM_SIZE DATE VM_CLOCK ICOUNT\n'; awk '{print NR, $1, "0 B", "2026-10-06", "00:00:00", "00:00:00.000", 0}' "$D/snaps" ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' >"$T/bin/sleep"
printf '#!/bin/sh\n[ "$1" = -u ] && echo 0 || exec /usr/bin/id "$@"\n' >"$T/bin/id"
printf '#!/bin/sh\nexit 1\n' >"$T/bin/nft"
printf '#!/bin/sh\nexit 0\n' >"$T/bin/systemctl"
chmod +x "$T/bin"/*

# ---------------------------------------------------------------- one host: a VM defined at 8192 MiB, 2 vCPUs, running
export FAKE_DIR=$T/fake FFF_VM_LIB=$ROOT/deploy/vm/host FFF_VM_CONF=$T/fff-vm.conf FFF_VM_ETC=$T/etc FFF_VM_STATE=$T/state FFF_VM_RUN=$T/run
export PATH=$T/bin:$PATH
conf() { # NAME=VALUE...: fff-vm.conf, over the base settings
  {
    printf 'VM_DISK_MODE=qcow2\nVM_IMAGE_DIR=%s/images\nNIGHTLY_MODE=always\nNTFY_URL_FILE=%s/no-ntfy\n' "$T" "$T"
    printf '%s\n' "$@"
  } >"$FFF_VM_CONF"
}
# The domain as install.sh left it: lib.sh's domain_xml at these settings, defined, running.
host() {
  rm -rf "${T:?}/etc" "$T/state" "$T/run" "$FAKE_DIR"
  mkdir -p "$T/etc" "$FAKE_DIR"
  conf "$@"
  echo 6e09a71e-c244-4a4b-8cf9-eaf7d12afd2c >"$FAKE_DIR/uuid"
  echo "shut off" >"$FAKE_DIR/state"
  echo 0 >"$FAKE_DIR/boots"
  (
    # shellcheck source=../host/lib.sh
    . "$FFF_VM_LIB/lib.sh"
    load_conf "$FFF_VM_CONF"
    domain_xml >"$FFF_VM_ETC/domain.xml"
    sed "s|</name>|</name>\n  <uuid>$(cat "$FAKE_DIR/uuid")</uuid>|" "$FFF_VM_ETC/domain.xml" >"$T/first.xml"
    virsh define "$T/first.xml" >/dev/null
    virsh start fff-portal >/dev/null
  )
  : >"$FAKE_DIR/calls"
}
nightly() { # runs fff-vm nightly --now; its output in $T/out, its exit code in $rc
  rc=0
  bash "$ROOT/deploy/vm/host/fff-vm" nightly --now >"$T/out" 2>&1 || rc=$?
}
size() { awk -F'[<>]' '$2 ~ /^memory( |$)/ {m = int($3 / 1024)} $2 ~ /^vcpu( |$)/ {c = $3} END {print m, c}' "$FAKE_DIR/${1:-live}.xml"; }
defines() { grep -c '^define ' "$FAKE_DIR/calls" || true; }

# 1. Nothing changed: a cold restart, nothing defined.
host VM_MEMORY_MB=8192 VM_VCPUS=2
nightly
[ "$rc" = 0 ] || fail "1: exit $rc"
[ "$(defines)" = 0 ] || fail "1: defined something with nothing changed"
[ "$(cat "$FAKE_DIR/boots")" = 2 ] || fail "1: no cold restart"
matches 'the portal is up' "$T/out" || fail "1: the portal is not up"
! matches -e 'applying' -e 'notify' "$T/out" || fail "1: it applied or alerted"
bash "$ROOT/deploy/vm/host/fff-vm" status >"$T/out" 2>&1
matches -x 'VM fff-portal: running (2 vCPUs, 8192 MiB, disk .*)' "$T/out" || fail "1: status does not show the running size"
matches -x '  definition: matches fff-vm.conf' "$T/out" || fail "1: status does not say the definition matches"
ok "nothing changed: cold restart, nothing defined, status says it matches"

# 2. 8192 -> 4096 MiB: shown by status, applied while off with the uuid, the old definition kept, and the VM runs it.
conf VM_MEMORY_MB=4096 VM_VCPUS=2
bash "$ROOT/deploy/vm/host/fff-vm" status >"$T/out" 2>&1
matches -F 'definition: fff-vm.conf asks for memory 8192 -> 4096 MiB: the next nightly applies it' "$T/out" || fail "2: status does not show the pending change"
nightly
[ "$rc" = 0 ] || fail "2: exit $rc"
matches -F 'applying fff-vm.conf to fff-portal: memory 8192 -> 4096 MiB' "$T/out" || fail "2: it did not log what changes"
matches -F "< <memory unit='MiB'>8192</memory>" "$T/out" || fail "2: it did not log the definition's diff"
matches -F "> <memory unit='MiB'>4096</memory>" "$T/out" || fail "2: it did not log the definition's diff"
[ "$(defines)" = 1 ] || fail "2: $(defines) defines, not 1"
[ "$(size live)" = "4096 2" ] || fail "2: the VM runs $(size live), not 4096 2"
awk '/^define / {d = NR} /^start / {s = NR} END {exit !(d && s && d < s)}' "$FAKE_DIR/calls" || fail "2: not defined before the start"
matches "<memory unit='KiB'>8388608</memory>" "$T/etc/domain.libvirt-prev.xml" || fail "2: libvirt's previous definition is not kept"
matches '<uuid>' "$T/etc/domain.libvirt-prev.xml" || fail "2: the kept definition has no uuid"
[ "$(stat -c %a "$T/etc/domain.libvirt-prev.xml")" = 600 ] || fail "2: the kept definition is not 0600"
matches "<memory unit='MiB'>8192</memory>" "$T/etc/domain.xml.prev" || fail "2: the previous domain.xml is not kept"
matches "<memory unit='MiB'>4096</memory>" "$T/etc/domain.xml" || fail "2: domain.xml is not the new one"
matches -F 'applied: memory 8192 -> 4096 MiB' "$T/out" || fail "2: it did not say it applied"
! matches 'notify' "$T/out" || fail "2: it alerted"
[ ! -e "$T/state/domain.rejected" ] || fail "2: marked rejected"
bash "$ROOT/deploy/vm/host/fff-vm" status >"$T/out" 2>&1
matches -x 'VM fff-portal: running (2 vCPUs, 4096 MiB, disk .*)' "$T/out" || fail "2: status after it"
matches -x '  definition: matches fff-vm.conf' "$T/out" || fail "2: status after it"
nightly
[ "$(defines)" = 1 ] || fail "2: the next nightly defined it again"
ok "8192 -> 4096 MiB: pending in status, defined with the uuid before the start, previous definition kept, VM runs 4096"

# 3. A definition libvirt refuses (vCPUs over its limit): kept as it was, alerted, and not tried again.
host VM_MEMORY_MB=4096 VM_VCPUS=2
conf VM_MEMORY_MB=4096 VM_VCPUS=500
nightly
[ "$rc" = 0 ] || fail "3: exit $rc"
matches -F 'notify: fff-vm: VM settings not applied: libvirt refused the definition fff-vm.conf asks for (vCPUs 2 -> 500)' "$T/out" || fail "3: no alert naming the refusal"
matches 'Maximum CPUs greater than' "$T/out" || fail "3: libvirt's reason is not passed on"
[ "$(size live)" = "4096 2" ] || fail "3: the VM is not on its old definition"
[ "$(size persistent)" = "4096 2" ] || fail "3: the VM is not on its old definition"
matches 'the portal is up' "$T/out" || fail "3: the portal is not up"
matches "<vcpu placement='static'>2</vcpu>" "$T/etc/domain.xml" || fail "3: domain.xml was replaced"
matches 'libvirt refused it' "$T/state/domain.rejected" || fail "3: not marked rejected"
bash "$ROOT/deploy/vm/host/fff-vm" status >"$T/out" 2>&1
matches -F 'definition: fff-vm.conf asks for vCPUs 2 -> 500; the VM did not come up with it' "$T/out" || fail "3: status does not show the rejection"
nightly
matches -F 'not applying fff-vm.conf (vCPUs 2 -> 500)' "$T/out" || fail "3: the next nightly tried it again"
[ "$(defines)" = 1 ] || fail "3: defined again"
ok "a definition libvirt refuses: old one kept, alert with libvirt's reason, not tried again"

# 4. A VM that does not start with it (more memory than the host): back to the old definition, started, alerted.
conf VM_MEMORY_MB=65536 VM_VCPUS=2
nightly
[ "$rc" = 0 ] || fail "4: exit $rc"
matches 'going back to the previous definition: it did not start: .*Cannot allocate memory' "$T/out" || fail "4: no going back on a failed start"
matches -F 'notify: fff-vm: VM settings rolled back: fff-vm.conf asked for memory 4096 -> 65536 MiB, and it did not start' "$T/out" || fail "4: no alert"
matches -F 'the portal is up' "$T/out" || fail "4: the portal is not up"
[ "$(size live)" = "4096 2" ] || fail "4: runs $(size live), defined $(size persistent)"
[ "$(size persistent)" = "4096 2" ] || fail "4: runs $(size live), defined $(size persistent)"
matches "<memory unit='MiB'>4096</memory>" "$T/etc/domain.xml" || fail "4: domain.xml was not put back"
matches 'it did not start' "$T/state/domain.rejected" || fail "4: not marked rejected"
ok "a VM that does not start with it: previous definition again, started, alert"

# 5. A VM that starts but whose portal does not answer (too little memory): back, started again, alerted.
conf VM_MEMORY_MB=512 VM_VCPUS=2
nightly
[ "$rc" = 0 ] || fail "5: exit $rc"
matches -F 'going back to the previous definition: the portal did not answer within 15 minutes of the start' "$T/out" || fail "5: no going back"
matches -F 'notify: fff-vm: VM settings rolled back: fff-vm.conf asked for memory 4096 -> 512 MiB' "$T/out" || fail "5: no alert"
matches -F 'the portal is up' "$T/out" || fail "5: the portal is not up after going back"
[ "$(size live)" = "4096 2" ] || fail "5: runs $(size live), defined $(size persistent)"
[ "$(size persistent)" = "4096 2" ] || fail "5: runs $(size live), defined $(size persistent)"
ok "a portal that does not come back with it: previous definition again, portal up, alert"

# 6. A changed fff-vm.conf is tried again (512 rejected; 6144 is new).
conf VM_MEMORY_MB=6144 VM_VCPUS=2
nightly
matches -F 'applied: memory 4096 -> 6144 MiB' "$T/out" || fail "6: a new size after a rejected one was not applied"
[ "$(size live)" = "6144 2" ] || fail "6: runs $(size live)"
ok "a changed fff-vm.conf after a rejection is applied"

# 7. A size change together with another MAC address: install.sh's, not applied, alerted.
host VM_MEMORY_MB=8192 VM_VCPUS=2
conf VM_MEMORY_MB=4096 VM_VCPUS=2 NET_VM_MAC=52:54:00:fa:41:0b
nightly
matches 'notify: fff-vm: VM settings not applied: fff-vm.conf changes fff-portal (memory 8192 -> 4096 MiB.*), but also its disk, seed, network or MAC address' "$T/out" || fail "7: no alert"
[ "$(defines)" = 0 ] || fail "7: defined it"
[ "$(size live)" = "8192 2" ] || fail "7: runs $(size live)"
ok "a change to the MAC address (or disk, seed, network) is left to install.sh, with an alert"

# 8. The definition libvirt has was never given the size fff-vm.conf and domain.xml say (an install.sh that wrote
# domain.xml and then failed at its define): compared with libvirt's own, so it is applied.
host VM_MEMORY_MB=8192 VM_VCPUS=2
conf VM_MEMORY_MB=4096 VM_VCPUS=2
(
  # shellcheck source=../host/lib.sh
  . "$FFF_VM_LIB/lib.sh"
  load_conf "$FFF_VM_CONF"
  domain_xml >"$FFF_VM_ETC/domain.xml"
)
nightly
matches -F 'applied: memory 8192 -> 4096 MiB' "$T/out" || fail "8: not applied"
[ "$(size live)" = "4096 2" ] || fail "8: runs $(size live)"
ok "libvirt's own definition, not domain.xml, decides what is pending"

# 9. NIGHTLY_MODE=if-required: no cold restart without a reason, and a pending size is one.
host VM_MEMORY_MB=8192 VM_VCPUS=2 NIGHTLY_MODE=if-required
conf VM_MEMORY_MB=8192 VM_VCPUS=2 NIGHTLY_MODE=if-required
rc=0; bash "$ROOT/deploy/vm/host/fff-vm" nightly >"$T/out" 2>&1 || rc=$?
matches 'if-required: no reboot needed tonight' "$T/out" || fail "9: restarted with no reason"
conf VM_MEMORY_MB=4096 VM_VCPUS=2 NIGHTLY_MODE=if-required
rc=0; bash "$ROOT/deploy/vm/host/fff-vm" nightly >"$T/out" 2>&1 || rc=$?
matches -F 'fff-vm.conf changes the VM (memory 8192 -> 4096 MiB)' "$T/out" || fail "9: the pending size is not a reason"
[ "$(size live)" = "4096 2" ] || fail "9: runs $(size live)"
ok "if-required: a pending size is a reason for tonight's cold restart"

echo "fff-vm-nightly.test.sh: $PASS passed"
