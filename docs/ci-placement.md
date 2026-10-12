# Where CI runs

Decided by lothsahn, 2026-10-10 (w911): GitHub-hosted runner minutes were most of the organisation's Actions use,
and ff-factory was most of those. The Linux jobs run on the FFBox build server's own runner containers; what needs
Windows, macOS, root, systemd or KVM stays hosted.

| Workflow, job | Runs on | Why |
|---|---|---|
| `ci.yml` `checks` (typecheck, unit tests with coverage, web build) | FFBox (`ffgithubrunners`) | Linux, Node |
| `ci.yml` `e2e` (Playwright, Chromium and WebKit, 3 shards) | FFBox | Linux, Node, the browsers in the image |
| `ci.yml` `secrets` (gitleaks), `identity` (noreply emails) | FFBox | Linux, git |
| `vm-scripts.yml` `plan` | FFBox | reads `git diff`; no API |
| `rerun-lost-runner.yml` `rerun` (w1102) | FFBox | needs the API, which the host makes for it (below) |
| `ops-socket.yml` (w638; was a job in `ci.yml`) | hosted `ubuntu-latest`, only when its files change | `sudo` and a running systemd |
| `vm-scripts.yml` `lint`, `e2e` | hosted | root, systemd, libvirt, KVM (the end-to-end jobs nest a VM) |
| `windows.yml`, `dev-drive.yml`, `worker-update.yml` (Windows) | hosted `windows-latest` | Windows |
| `worker-update.yml` (macOS) | hosted `macos-latest` | macOS |

## What a job on FFBox can and cannot do

A runner container is single-use, runs as root with every capability but CAP_CHOWN, CAP_DAC_OVERRIDE and CAP_FOWNER dropped (measured, w1167), and sits behind an egress fence.

- **Reaches from outside:** the npm registry and GitHub's Actions service. **Never `github.com` or `api.github.com`**: an
  SNI fence cannot limit those to one repository, so one POST to `/gists` with a credential lifted out of a test would
  leave through it. A job that needs a fact from GitHub asks the host (ffbox `scripts/ci_lane.py` `serve_github`).
- **A job that must act on GitHub's API hands the call to the host** (w1102). `rerun-lost-runner.yml` writes its own
  `GITHUB_TOKEN` (`actions: write` on this repository, gone when the job ends), the run id and the repository into
  `/ffghr/out/rerun.request` and waits for `rerun.done`; the host (ffbox `scripts/ci_lane.py` `serve_rerun_lost`) makes the
  four fixed calls with that token (list the run's jobs, read their annotations and logs, re-run the failed jobs). The
  job's token gives the host no more than the job already had, which is why this is not a hole in the fence. The decision
  logic, with its tests, lives in ffbox now.
- **The checkout** comes from the host's mirror of this repository: `/opt/ffghr/ffghr-workspace.sh use-mirror "$sha"`,
  then `actions/checkout`, pinned by commit SHA (the image carries the archive of exactly that commit and cannot download
  any other action).
- **In the image, not installed by the job:** Node 24, npm, gitleaks, jq, Playwright's Chromium and WebKit, and the system
  libraries they link against. There is no `actions/setup-node`, no `actions/cache` and no `sudo`. Versions: ffbox
  `scripts/Dockerfile` (`NODE_VERSION`, `GITLEAKS_VERSION`, `PLAYWRIGHT_VERSION`). **Upgrading Node, gitleaks or
  Playwright means bumping the number there too**; the e2e job's first step fails and says so when `package-lock.json` and
  the image's Playwright differ. The browsers are baked because Chromium's download is served from
  `storage.googleapis.com`, every Google Cloud bucket, which the fence cannot name.
- **Artifacts** go through `.github/actions/ffghr-artifact-handoff`: the host uploads them on the job's own credential.
- **PowerShell 7** is not in the image, so the scripts' tests that need `pwsh` skip (`server/testPowershell.ts`); the
  Windows job (`windows.yml`) is where they run.
- **The repository is public and the runners are shared with private repositories, so no job from a fork runs on
  FFBox** (w1167). FFBox's runner image runs a job-started hook (ffbox `scripts/ci-job-started.sh`, ffbox PR #25) before a
  job's first step, and it fails any job whose event names a head repository other than this one: a fork's pull request
  (`pull_request`, `pull_request_target`) or a `workflow_run` fired by a fork's run. It is in the image, so a pull request
  cannot edit it out, which it can do to an `if:` in a workflow (a `pull_request` run uses the workflow file from the pull
  request). Behind it stays the repository setting (Settings, Actions, General, "Require approval for all external
  contributors"), and no FFBox job holds a secret. A maintainer who wants CI on a contributor's change pushes it to a branch
  here and opens the pull request from that.

## The visual baselines

`e2e/__screenshots__/*-linux.png` were rendered on GitHub's `ubuntu-latest`; FFBox's containers are Ubuntu 22.04 with other
font versions. The first FFBox run is the one that tells whether they still match; if they do not, re-render them with
the `update_snapshots` input (the `linux-snapshots` artifact) and commit them. See the pull request that moved CI here.

## What is still hosted, and why (w1167, 2026-10-12)

**Hosted runners cost this repository nothing.** It is public, and GitHub's billing page says "GitHub Actions usage is
free for self-hosted runners and for public repositories that use standard GitHub-hosted runners" (docs.github.com,
GitHub Actions billing). The minutes below are not billed; they matter only for the organisation's concurrency (20 hosted
jobs at once on the free plan, 5 of them macOS), which the game's repository does not use (its workflows ask only for
self-hosted labels).

Measured from the Actions API, 2026-09-12 to 2026-10-12, each job rounded up to a minute (most of the Linux minutes were
`ci.yml` before w911 moved it):

| Still hosted | Minutes in 30 days | Of which the last 7 days |
|---|---|---|
| `vm-scripts.yml` `e2e` (nested VM; before w925 it also ran on every push to main) | 9,320 | 9,157 (pull requests 4,748, pushes 3,483, nightly 479, by hand 447) |
| `vm-scripts.yml` `lint` | 715 | 668 |
| `worker-update.yml` Windows / macOS | 465 / 179 | all |
| `windows.yml` | 145 | all |
| `dev-drive.yml` | 33 | 33 |
| `ops-socket.yml` (and its earlier job in `ci.yml`) | 87 | 6 since w1102's path filter |

**What a runner container on FFBox can do**, measured by a probe job (ff-factory PR #367, run 38322512537): Ubuntu 22.04,
root with only `CAP_CHOWN`, `CAP_DAC_OVERRIDE` and `CAP_FOWNER`, PID 1 is the runner (no systemd), no `/dev/kvm` (the
host's CPUs have VT-x/AMD-V), cgroups read-only, `unshare` refused, no `sudo`, `nft`, `zfs`, `qemu` or `pwsh`, and no
package mirror or other outside host beyond the fence's list. So none of these jobs fits in one:

- **`ops-socket.yml`** needs root and a running systemd (it installs a socket unit and reads the journal).
- **`vm-scripts.yml` `lint`** runs as root on Ubuntu 26.04 on purpose (the guest's release, D14): the installers' dry runs,
  `nft`, and `systemd-analyze verify` of the guest's units against 26.04's systemd. A 22.04 container would check them
  against an older systemd and shellcheck (0.8.0).
- **`vm-scripts.yml` `e2e`** needs KVM, root, ZFS and libvirt on the runner, and reaches github.com, claude.ai, the Ubuntu
  archive and cloud images, NodeSource, cli.github.com and pkgs.tailscale.com, which the fence keeps from FFBox's containers.

What FFBox would need to run them: a second, privileged runner class, one fresh Ubuntu VM per job (24.04 or 26.04) booted
from a cloud image inside a single-use container that is given `/dev/kvm`, with the runner and the fork hook inside the VM
and its own egress list. That needs a root step on the FFBox host (the container daemon's account in the `kvm` group), a
wider egress list for that class only, and puts KVM, a kernel attack surface, within reach of a public repository's jobs on
the host that runs the portal's VM (whose design keeps every FFBox account out of libvirt, w441). It is lothsahn's call
(w1167); until then these jobs stay hosted.

- **Windows jobs** (`windows.yml`, `dev-drive.yml`, `worker-update.yml`) need an elevated Windows with the virtual disk
  service and PowerShell 5 and 7, clean per run (the Dev Drive job makes and detaches a VHDX). The organisation's only
  self-hosted Windows runner, `FinalFactory-Mode2-Windows-BEAST` (label `finalfactory-mode2-windows`), is the determinism
  gate's and label-locked. The free plan has only the Default runner group, so a new runner cannot be limited to this
  repository by group.
- **macOS** (`worker-update.yml`) may run only on Apple hardware (Apple's licence), so not on FFBox; m3 and m5 are machines
  the team works on, and the job installs and updates a worker under launchd.
- **`rerun-lost-runner.yml`** (on FFBox since w1102) re-runs the hosted Windows jobs GitHub loses.

## Notes for the next person

- The artifact hand-off action is `index.cjs`, not `index.js`: this repository's `package.json` says `"type": "module"`, which
  makes a `.js` file ESM and the action's `require` fail with "require is not defined in ES module scope".
- The e2e server (`e2e/server.ts`) sets the host guard's disk thresholds low. A runner with less free space than the guard's 80 GB
  warning (an FFBox container's workspace has 56 GB) otherwise shows a "disk space is low" bar on every page, which shifts every
  screenshot 70 px and leaves a bar behind after a test dismisses its own.
