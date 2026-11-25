#!/usr/bin/env bash
# the PowerShell command is single-quoted on purpose
# shellcheck disable=SC2016
# Lint the portal VM's scripts (CI's "Portal VM scripts" workflow, and by hand): shellcheck and bash -n on every
# shell script, systemd-analyze verify on every unit, and a parse of the measurement PowerShell script when pwsh is
# there. Run from the repository root. --units needs root (it installs the scripts where the units point, on a
# throwaway machine only). --shellcheck-only stops after bash -n and shellcheck.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
units=0
[ "${1:-}" != --units ] || units=1

scripts=(deploy/vm/host/install.sh deploy/vm/host/uninstall.sh deploy/vm/host/vm-rollback.sh deploy/vm/host/fff-vm deploy/vm/host/lib.sh deploy/vm/host/pathwatch.sh
  deploy/vm/host/answers.sh deploy/vm/host/guest.sh deploy/vm/host/vault.sh deploy/vm/host/machine-ssh.sh deploy/vm/guest/fff-machine-ssh
  deploy/vm/host/fff-vm.conf.example deploy/vm/guest/install.sh deploy/vm/guest/fffctl deploy/vm/guest/fff-update deploy/vm/guest/fff-health
  deploy/vm/guest/fff-backup deploy/vm/guest/fff-backup-drill deploy/vm/guest/fff-base-refresh deploy/vm/guest/fff-migrate deploy/vm/guest/lib.sh deploy/vm/guest/fff.conf.example
  deploy/vm/test/lint.sh deploy/vm/test/ci-vm-e2e.sh deploy/vm/test/fff-vm-nightly.test.sh deploy/vm/test/fff-vm-path.test.sh deploy/vm/test/fff-machine-ssh.test.sh
  deploy/vm/guest/fff-ops-launch deploy/vm/guest/fff-ops-priv deploy/vm/guest/fff-ops-ssh deploy/vm/guest/fff-ops-scp-ssh deploy/vm/guest/fff-ops-sync
  deploy/vm/guest/ops-bin/ssh deploy/vm/guest/ops-bin/fffctl deploy/vm/guest/ops-bin/scp deploy/vm/guest/ops-bin/sftp deploy/vm/guest/ops-bin/fff-machine-ssh deploy/vm/test/fff-ops.test.sh
  deploy/vm/test/fff-ops-socket.test.sh deploy/vm/guest/fff-watchdog deploy/vm/test/fff-watchdog.test.sh deploy/vm/test/fff-health.test.sh deploy/vm/test/fff-units.test.sh deploy/vm/test/fff-vault-sync.test.sh deploy/vm/test/fff-vault-add.test.sh deploy/vm/test/fff-conf.test.sh deploy/vm/test/fff-disk-usage.test.sh deploy/vm/test/fff-update.test.sh deploy/vm/test/fff-fence-check.test.sh deploy/vm/test/fff-root-links.test.sh deploy/vm/test/fff-apt-keys.test.sh deploy/vm/test/fff-config-host.test.sh)
for f in "${scripts[@]}"; do bash -n "$f"; done
echo "bash -n: ${#scripts[@]} files parse"
shellcheck --version | sed -n 2p
shellcheck -x -P SCRIPTDIR "${scripts[@]}"
echo "shellcheck: clean"
# The pre-push check (scripts/prepush.ts, w924) wants only the parse and shellcheck, not the tests below.
[ "${1:-}" != --shellcheck-only ] || exit 0
# Every executable script really is executable in git (the installers copy modes from the checkout).
for f in deploy/vm/host/install.sh deploy/vm/host/uninstall.sh deploy/vm/host/vm-rollback.sh deploy/vm/host/fff-vm deploy/vm/guest/install.sh \
  deploy/vm/guest/fffctl deploy/vm/guest/fff-update deploy/vm/guest/fff-health deploy/vm/guest/fff-backup deploy/vm/guest/fff-backup-drill deploy/vm/guest/fff-base-refresh \
  deploy/vm/guest/fff-migrate deploy/vm/host/machine-ssh.sh deploy/vm/guest/fff-machine-ssh deploy/vm/test/lint.sh deploy/vm/test/ci-vm-e2e.sh \
  deploy/vm/test/fff-vm-nightly.test.sh deploy/vm/test/fff-vm-path.test.sh deploy/vm/test/fff-machine-ssh.test.sh deploy/vm/guest/fff-ops-launch deploy/vm/guest/fff-ops-priv   deploy/vm/guest/fff-ops-ssh deploy/vm/guest/fff-ops-scp-ssh deploy/vm/guest/fff-ops-sync deploy/vm/guest/ops-bin/ssh deploy/vm/guest/ops-bin/fffctl deploy/vm/guest/ops-bin/scp deploy/vm/guest/ops-bin/sftp deploy/vm/guest/ops-bin/fff-machine-ssh deploy/vm/test/fff-ops.test.sh deploy/vm/test/fff-ops-socket.test.sh deploy/vm/guest/fff-watchdog deploy/vm/test/fff-watchdog.test.sh deploy/vm/test/fff-health.test.sh deploy/vm/test/fff-units.test.sh deploy/vm/test/fff-vault-sync.test.sh deploy/vm/test/fff-vault-add.test.sh deploy/vm/test/fff-conf.test.sh deploy/vm/test/fff-disk-usage.test.sh deploy/vm/test/fff-update.test.sh deploy/vm/test/fff-fence-check.test.sh deploy/vm/test/fff-root-links.test.sh deploy/vm/test/fff-apt-keys.test.sh deploy/vm/test/fff-config-host.test.sh; do
  [ "$(git ls-files -s "$f" | cut -c1-6)" = 100755 ] || { echo "$f is not executable in git (git update-index --chmod=+x)"; exit 1; }
done
python3 -m json.tool deploy/vm/guest/config.vm.example.json >/dev/null && echo "config.vm.example.json: valid JSON"
# fff-vm nightly applying fff-vm.conf's size, against a fake libvirt (w537). It needs jq; a throwaway machine gets it.
if [ "$units" = 1 ] && ! command -v jq >/dev/null; then apt-get install -y -q jq >/dev/null; fi
deploy/vm/test/fff-vm-nightly.test.sh
# The path from the internet to the portal (w681): fff-vm watch's checks and repairs, against recorded command output.
deploy/vm/test/fff-vm-path.test.sh
# The portal's ssh aliases and pinned host keys for the machines (w537), against fake machines.
deploy/vm/test/fff-machine-ssh.test.sh
# The orchestration worker's launcher and wrappers (w597), against a fake claude and a fake ssh.
deploy/vm/test/fff-ops.test.sh
# The unit watchdog (w698): restarts, back-off, give-up, what it leaves alone, against a fake systemctl; needs jq and node.
deploy/vm/test/fff-watchdog.test.sh
# The health restart (w1377): the count, the back-off within the hour, the diagnostics line, the grace and the hold, against a
# fake systemctl and curl.
deploy/vm/test/fff-health.test.sh
# The host side of the vault (w744): fff-vm vault-sync and the installer's sync agree, claude-tokens/ alone, nothing removed
# whose file exists, the installed scripts follow the checkout; and (w749) the copy of the VM's own entries to the host, the
# conflict rule, removal for good.
deploy/vm/test/fff-vault-sync.test.sh
# `fffctl vault add-claude` (w749): the next free vault-<person>-<n>, the token from stdin only, refusals that show nothing.
deploy/vm/test/fff-vault-add.test.sh
# `fffctl disk-usage` (w2267): sizes, counts and dates only, nothing written, no file's text, logs counted by program.
deploy/vm/test/fff-disk-usage.test.sh
# What the portal's own account can open (w5506): fffctl fence-check, unprivileged.
deploy/vm/test/fff-fence-check.test.sh
# fff-update's trust in what it runs as root (w5505): the move to root's clone and releases, release_problem's refusals,
# forged and unfit records not taken, rollback only to a fit release, a hostile build never marked ready. Root only.
if [ "$units" = 1 ]; then deploy/vm/test/fff-update.test.sh; fi
# Root in fff's folders (w5531): tell_dispatcher, data_write and fff_dir refuse a symbolic link fff put in place of a
# folder or a file, log it and leave its target alone; a normal folder works. Root only.
if [ "$units" = 1 ]; then deploy/vm/test/fff-root-links.test.sh; fi
# The units as a whole (w698): WantedBy and enable, Restart= and StartLimit, no socket ordered after a service (the boot-time
# ordering cycle that left fff-ops.socket dead after a reboot), the boot graph through systemd-analyze when it is there.
# The apt signing keys, pinned by fingerprint (w5530): a wrong fingerprint, an extra key and a non-key abort.
deploy/vm/test/fff-apt-keys.test.sh
# A kept config's "host" (w5538): missing and unreadable warn differently.
deploy/vm/test/fff-config-host.test.sh
deploy/vm/test/fff-units.test.sh

if command -v pwsh >/dev/null; then
  pwsh -NoProfile -Command '$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile("deploy/vm/measure/measure-portal.ps1", [ref]$null, [ref]$e); if ($e.Count) { $e; exit 1 }; "measure-portal.ps1: parses"'
fi

if [ "$units" = 1 ]; then
  # systemd-analyze verify checks each unit's executables and user exist, so put them where the units point.
  id fff >/dev/null 2>&1 || useradd --system --user-group fff
  install -d /usr/local/lib/fff /usr/local/lib/fff-vm /srv/fff/app/current
  for f in fff-update fff-health fff-backup fff-backup-drill fff-base-refresh fff-ops-launch fff-ops-sync; do install -m 0755 "deploy/vm/guest/$f" /usr/local/lib/fff/; done
  install -m 0755 deploy/vm/host/fff-vm /usr/local/sbin/fff-vm
  install -m 0755 deploy/vm/guest/fffctl /usr/local/sbin/fffctl
  # fff-portal.service runs the execute-only node its ExecStartPre installs (w5506); verify wants it there now.
  install -m 0111 "$(readlink -f "$(command -v node)")" /usr/local/lib/fff/node-portal
  tmp=$(mktemp -d)
  id fff-ops >/dev/null 2>&1 || useradd --system --user-group fff-ops
  # The guest's units as install.sh writes them (the templates rendered), then the host's.
  FFF_UNITS_OUT=$tmp deploy/vm/test/fff-units.test.sh >/dev/null
  cp deploy/vm/host/units/* "$tmp/"
  # verify exits 0 on a line it ignores, so read what it says (w4500: "fff-portal.service:40: Invalid syntax, ignoring"
  # sat in the portal's journal for weeks), and fail on any. First prove this systemd reports such a line: a probe unit
  # with the same empty SetCredential= (systemd 259 on the CI runner says "Invalid syntax, ignoring: probe-key:",
  # measured on PR #986). Its output is captured before grep: verify exits non-zero on the probe (it also warns about
  # system units), which under pipefail failed a "verify | grep -q" pipe that had matched.
  probe=$(mktemp -d)
  printf '[Service]\nType=oneshot\nExecStart=/bin/true\nSetCredential=probe-key:\n' >"$probe/fff-lint-probe.service"
  probe_out=$(systemd-analyze verify --man=no "$probe/fff-lint-probe.service" 2>&1 || true)
  rm -rf "$probe"
  if ! grep -qiF 'invalid syntax, ignoring: probe-key:' <<<"$probe_out"; then
    echo "FAIL: systemd-analyze verify ($(systemctl --version | head -1)) did not report the empty SetCredential= probe: $probe_out"; exit 1
  fi
  verify_out=$(systemd-analyze verify --man=no "$tmp"/*.service "$tmp"/*.socket "$tmp"/*.timer "$tmp"/*.path 2>&1) || { echo "$verify_out"; exit 1; }
  [ -z "$verify_out" ] || echo "$verify_out"
  if printf '%s\n' "$verify_out" | grep -iE 'invalid syntax|unknown key|unknown section|failed to parse|ignoring'; then
    echo "FAIL: systemd-analyze verify ignored a line of a unit (above)"; exit 1
  fi
  rm -rf "$tmp"
  echo "systemd-analyze verify: clean"
fi
