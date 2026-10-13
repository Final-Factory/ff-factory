# Where CI runs

Decided by lothsahn, 2026-10-10 (w911): GitHub-hosted runner minutes were most of the organisation's Actions use,
and ff-factory was most of those. The Linux jobs run on the FFBox build server's own runner containers; what needs
Windows, macOS, root, systemd or KVM stays hosted.

**Portable since w1170 (2026-10-12).** Each job's `runs-on` reads a repository variable (Settings, Secrets and variables,
Actions, Variables), so a job moves between FFBox, GitHub's runners and another self-hosted machine without a workflow edit,
and the steps that differ between runners are [Final-Factory/ci-actions](https://github.com/Final-Factory/ci-actions)
(`checkout`, `setup`, `playwright`, `upload`), pinned by commit. Unset, every job runs where the table says.

| Workflow, job | Runs on (default) | Variable | Why |
|---|---|---|---|
| `ci.yml` `checks` (typecheck, unit tests with coverage, web build) | FFBox (`ffgithubrunners`) | `FF_LINUX_RUNNER` | Linux, Node |
| `ci.yml` `e2e` (Playwright, Chromium and WebKit, 3 shards) | FFBox | `FF_E2E_RUNNER` | Linux, Node, the browsers in the image; its own variable because the screenshot baselines match one machine (below) |
| `ci.yml` `secrets` (gitleaks), `identity` (noreply emails) | FFBox | `FF_LINUX_RUNNER` | Linux, git |
| `vm-scripts.yml` `plan` | FFBox | `FF_LINUX_RUNNER` | reads `git diff`; no API |
| `rerun-lost-runner.yml` `rerun` (w1102) | FFBox | none | needs the API, which the FFBox host makes for it (below); it cannot run anywhere else |
| `ops-socket.yml` (w638; was a job in `ci.yml`) | hosted `ubuntu-latest`, only when its files change | none | `sudo` and a running systemd |
| `vm-scripts.yml` `lint`, `e2e` | hosted | none | root, systemd, libvirt, KVM (the end-to-end jobs nest a VM) |
| `windows.yml`, `dev-drive.yml`, `worker-update.yml` (Windows) | hosted `windows-latest` | `FF_WINDOWS_RUNNER` | Windows |
| `worker-update.yml` (macOS) | hosted `macos-latest` | `FF_MACOS_RUNNER` | macOS |

## Choosing a runner: cost and security

| | FFBox (`ffgithubrunners`) | GitHub-hosted | Another self-hosted machine |
|---|---|---|---|
| **Cost** | no per-minute charge; the box's capacity (`githubrunner.pool.max` jobs at once, shared with the game's builds and agent runs) | **free**: this repository is public, and standard hosted runners cost nothing for public repositories. A private repository pays per minute (from January 2026: Linux $0.006, Windows $0.010, macOS $0.062) after the plan's included minutes | no per-minute charge (GitHub's announced $0.002/min self-hosted fee was postponed and never applied to public repositories); the machine and its upkeep |
| **Egress** | fenced: npm, Unity and the Actions service; never `github.com` or `api.github.com` | open | whatever the machine allows |
| **Isolation** | a fresh container per job, capabilities dropped, single-use registration | a fresh VM per job | persistent unless set up otherwise: one job's files, processes and credentials are there for the next |
| **Fork pull requests** | refused by the image's job-started hook (ffbox w1167), and need an owner's approval here | run in their own VM | **run on the machine** unless approval is required; GitHub advises against self-hosted runners for public repositories |

A public repository on another self-hosted machine needs, at least: approval for outside contributors (Settings, Actions,
General), single-use (`--ephemeral` or JIT) registrations, a label of its own (a bare `self-hosted` reaches every runner in
the organisation that kept its default labels, FFBox's among them since 2026-10-12), and no secret in a job a pull request
can start.

Moving a job off FFBox costs nothing for this repository; it loses the fence, and the FFBox host's warm `node_modules`
and browsers are installed per job instead (`setup` and `playwright` do it).

## What a job on FFBox can and cannot do

A runner container is single-use, runs as root with every capability but CAP_CHOWN, CAP_DAC_OVERRIDE and CAP_FOWNER dropped
(measured, w1167), and sits behind an egress fence.

- **Reaches from outside:** the npm registry and GitHub's Actions service. **Never `github.com` or `api.github.com`**: an
  SNI fence cannot limit those to one repository, so one POST to `/gists` with a credential lifted out of a test would
  leave through it. A job that needs a fact from GitHub asks the host (ffbox `scripts/ci_lane.py` `serve_github`).
- **A job that must act on GitHub's API hands the call to the host** (w1102). `rerun-lost-runner.yml` writes its own
  `GITHUB_TOKEN` (`actions: write` on this repository, gone when the job ends), the run id and the repository into
  `/ffghr/out/rerun.request` and waits for `rerun.done`; the host (ffbox `scripts/ci_lane.py` `serve_rerun_lost`) makes the
  four fixed calls with that token (list the run's jobs, read their annotations and logs, re-run the failed jobs). The
  job's token gives the host no more than the job already had, which is why this is not a hole in the fence. The decision
  logic, with its tests, lives in ffbox now.
- **The checkout** comes from the host's mirror of this repository: `ci-actions/checkout` runs
  `/opt/ffghr/ffghr-workspace.sh use-mirror "$sha"`, then `actions/checkout`. Every action is pinned by commit: the
  container cannot download one, and the runner reads each from the host's action cache (ffbox `scripts/actioncache.py`),
  which archives every commit of ci-actions and the actions it pins, about a minute after they are pushed. This
  repository must stay on the host's `extra_mirrors`.
- **In the image, not installed by the job:** Node 24, npm, gitleaks, jq, Playwright's Chromium and WebKit, and the system
  libraries they link against; `ci-actions/setup` and `ci-actions/playwright` check the versions there and install them only
on other runners. There is no `actions/cache` and no `sudo`. Versions: ffbox
  `scripts/Dockerfile` (`NODE_VERSION`, `GITLEAKS_VERSION`, `PLAYWRIGHT_VERSION`). **Upgrading Node, gitleaks or
  Playwright means bumping the number there too**; on FFBox `setup` and `playwright` fail naming the line to bump when the
  workflow or `package-lock.json` and the image differ. The browsers are baked because Chromium's download is served from
  `storage.googleapis.com`, every Google Cloud bucket, which the fence cannot name.
- **Artifacts** go through `ci-actions/upload`, which on FFBox hands them to the host (`ci-actions/ffbox-handoff`), which
  uploads them on the job's own credential; elsewhere it is `actions/upload-artifact`.
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

`e2e/__screenshots__/*-linux.png` match one machine's fonts. They were rendered on GitHub's `ubuntu-latest`; FFBox's containers
are Ubuntu 22.04 with other font versions. Setting `FF_E2E_RUNNER` moves the job to other fonts, so re-render them there in
the same change. The first FFBox run is the one that tells whether they still match; if they do not, re-render them with
the `update_snapshots` input (the `linux-snapshots` artifact) and commit them. See the pull request that moved CI here.

## What is still hosted, and why (w1167, 2026-10-12)

The workflows are ready to move (the variables above); the runners are not. Hosted runners cost this repository nothing
(the cost table above), so what moving buys is the organisation's hosted concurrency (20 jobs at once on the free plan, 5
of them macOS), which the game's repository does not use (its workflows ask only for self-hosted labels).

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
root with three capabilities, PID 1 is the runner (no systemd), no `/dev/kvm` (the host's CPUs have VT-x/AMD-V), cgroups
read-only, `unshare` refused, no `sudo`, `nft`, `zfs`, `qemu` or `pwsh`, and no package mirror or other outside host beyond
the fence's list. So none of the Linux jobs still hosted fits in one:

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
  repository by group (ffbox `docs/ci-runner-security-findings.md` F2).
- **macOS** (`worker-update.yml`) may run only on Apple hardware (Apple's licence), so not on FFBox; m3 and m5 are machines
  the team works on, and the job installs and updates a worker under launchd.
- **`rerun-lost-runner.yml`** (on FFBox since w1102) re-runs the hosted Windows jobs GitHub loses.

## Notes for the next person

- The artifact hand-off action (now `ci-actions/ffbox-handoff`) is `index.cjs`, not `index.js`: it was written here, where
  `package.json` says `"type": "module"`, which makes a `.js` file ESM and its `require` fail.
- The e2e server (`e2e/server.ts`) sets the host guard's disk thresholds low. A runner with less free space than the guard's 80 GB
  warning (an FFBox container's workspace has 56 GB) otherwise shows a "disk space is low" bar on every page, which shifts every
  screenshot 70 px and leaves a bar behind after a test dismisses its own.
