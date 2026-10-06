#!/usr/bin/env bash
# the stream's first lines are single-quoted on purpose: they expand in the VM
# shellcheck disable=SC2016
# machine-ssh.sh (w537): the portal VM's ssh to the machines it deploys daemons to, from the FFBox host. Root only.
# Since w568 a machine's worker installer sets its own ssh up (docs/worker-install.md, "The portal's ssh"): this stays
# the repair and check tool for the machines from before that (deploy/vm/guest/machines.ssh). It keeps nothing on this
# host: it writes into the VM, as the portal's account, over fff-vm ssh.
#
#   sudo deploy/vm/host/machine-ssh.sh --check   read only: each machine's alias, pinned key, the key the VM sees, ssh
#   sudo deploy/vm/host/machine-ssh.sh --fix     write the aliases and the pinned host keys in the VM, then check
#
# It streams this checkout's deploy/vm/guest/fff-machine-ssh and machines.ssh into the VM (fff-vm ssh) and runs them
# there as the portal's account, so it works on a VM whose own copy is older or missing. A VM installed or updated
# (fffctl update) after w537 does the same by itself.
set -o errexit -o nounset -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
case "${1:-}" in
  --check | --fix) ;;
  *) echo "usage: sudo $0 --check|--fix"; exit 2 ;;
esac
need_root
guest=$here/../guest
for f in fff-machine-ssh machines.ssh; do [ -r "$guest/$f" ] || die "no $guest/$f in this checkout (git -C ~/ff-factory pull)"; done
{
  echo 'data=$(mktemp); trap '"'"'rm -f "$data"'"'"' EXIT'
  echo "cat >\"\$data\" <<'FFF_MACHINES_SSH'"
  cat "$guest/machines.ssh"
  echo 'FFF_MACHINES_SSH'
  printf 'set -- --data "$data" %s\n' "$1"
  sed '1d' "$guest/fff-machine-ssh"
} | "${FFF_VM_BIN:-/usr/local/sbin/fff-vm}" ssh 'sudo -H -u fff bash -s'
