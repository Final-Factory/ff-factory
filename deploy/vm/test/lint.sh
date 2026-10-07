#!/usr/bin/env bash
# the PowerShell command is single-quoted on purpose
# shellcheck disable=SC2016
# Lint the portal VM's scripts (CI's "Portal VM scripts" workflow, and by hand): shellcheck and bash -n on every
# shell script, systemd-analyze verify on every unit, and a parse of the measurement PowerShell script when pwsh is
# there. Run from the repository root. --units needs root (it installs the scripts where the units point, on a
# throwaway machine only).
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
units=0
[ "${1:-}" != --units ] || units=1

scripts=(deploy/vm/host/install.sh deploy/vm/host/uninstall.sh deploy/vm/host/vm-rollback.sh deploy/vm/host/fff-vm deploy/vm/host/lib.sh
  deploy/vm/host/answers.sh deploy/vm/host/guest.sh deploy/vm/host/vault.sh deploy/vm/host/machine-ssh.sh deploy/vm/guest/fff-machine-ssh
  deploy/vm/host/fff-vm.conf.example deploy/vm/guest/install.sh deploy/vm/guest/fffctl deploy/vm/guest/fff-update deploy/vm/guest/fff-health
  deploy/vm/guest/fff-backup deploy/vm/guest/fff-base-refresh deploy/vm/guest/fff-migrate deploy/vm/guest/lib.sh deploy/vm/guest/fff.conf.example
  deploy/vm/test/lint.sh deploy/vm/test/ci-vm-e2e.sh deploy/vm/test/fff-vm-nightly.test.sh deploy/vm/test/fff-machine-ssh.test.sh
  deploy/vm/guest/fff-ops-launch deploy/vm/guest/fff-ops-priv deploy/vm/guest/fff-ops-ssh deploy/vm/guest/fff-ops-sync
  deploy/vm/guest/ops-bin/ssh deploy/vm/guest/ops-bin/fffctl deploy/vm/test/fff-ops.test.sh)
for f in "${scripts[@]}"; do bash -n "$f"; done
echo "bash -n: ${#scripts[@]} files parse"
shellcheck --version | sed -n 2p
shellcheck -x -P SCRIPTDIR "${scripts[@]}"
echo "shellcheck: clean"
# Every executable script really is executable in git (the installers copy modes from the checkout).
for f in deploy/vm/host/install.sh deploy/vm/host/uninstall.sh deploy/vm/host/vm-rollback.sh deploy/vm/host/fff-vm deploy/vm/guest/install.sh \
  deploy/vm/guest/fffctl deploy/vm/guest/fff-update deploy/vm/guest/fff-health deploy/vm/guest/fff-backup deploy/vm/guest/fff-base-refresh \
  deploy/vm/guest/fff-migrate deploy/vm/host/machine-ssh.sh deploy/vm/guest/fff-machine-ssh deploy/vm/test/lint.sh deploy/vm/test/ci-vm-e2e.sh \
  deploy/vm/test/fff-vm-nightly.test.sh deploy/vm/test/fff-machine-ssh.test.sh deploy/vm/guest/fff-ops-launch deploy/vm/guest/fff-ops-priv   deploy/vm/guest/fff-ops-ssh deploy/vm/guest/fff-ops-sync deploy/vm/guest/ops-bin/ssh deploy/vm/guest/ops-bin/fffctl deploy/vm/test/fff-ops.test.sh; do
  [ "$(git ls-files -s "$f" | cut -c1-6)" = 100755 ] || { echo "$f is not executable in git (git update-index --chmod=+x)"; exit 1; }
done
python3 -m json.tool deploy/vm/guest/config.vm.example.json >/dev/null && echo "config.vm.example.json: valid JSON"
# fff-vm nightly applying fff-vm.conf's size, against a fake libvirt (w537). It needs jq; a throwaway machine gets it.
if [ "$units" = 1 ] && ! command -v jq >/dev/null; then apt-get install -y -q jq >/dev/null; fi
deploy/vm/test/fff-vm-nightly.test.sh
# The portal's ssh aliases and pinned host keys for the machines (w537), against fake machines.
deploy/vm/test/fff-machine-ssh.test.sh
# The orchestration worker's launcher and wrappers (w597), against a fake claude and a fake ssh.
deploy/vm/test/fff-ops.test.sh

if command -v pwsh >/dev/null; then
  pwsh -NoProfile -Command '$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile("deploy/vm/measure/measure-portal.ps1", [ref]$null, [ref]$e); if ($e.Count) { $e; exit 1 }; "measure-portal.ps1: parses"'
fi

if [ "$units" = 1 ]; then
  # systemd-analyze verify checks each unit's executables and user exist, so put them where the units point.
  id fff >/dev/null 2>&1 || useradd --system --user-group fff
  install -d /usr/local/lib/fff /usr/local/lib/fff-vm /srv/fff/app/current
  for f in fff-update fff-health fff-backup fff-base-refresh fff-ops-launch fff-ops-sync; do install -m 0755 "deploy/vm/guest/$f" /usr/local/lib/fff/; done
  install -m 0755 deploy/vm/host/fff-vm /usr/local/sbin/fff-vm
  install -m 0755 deploy/vm/guest/fffctl /usr/local/sbin/fffctl
  tmp=$(mktemp -d)
  cp deploy/vm/host/units/* deploy/vm/guest/units/* "$tmp/"
  systemd-analyze verify --man=no "$tmp"/*.service "$tmp"/*.timer "$tmp"/*.path
  rm -rf "$tmp"
  echo "systemd-analyze verify: clean"
fi
