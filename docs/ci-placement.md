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

A runner container is single-use, runs as root with every capability dropped, and sits behind an egress fence.

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
- **The repository is public and the runners are shared with private repositories.** Fork pull requests need an
  owner's approval before any job runs (Settings, Actions, General, "Require approval for all external contributors"),
  and no FFBox job holds a secret.

## The visual baselines

`e2e/__screenshots__/*-linux.png` match one machine's fonts. They were rendered on GitHub's `ubuntu-latest`; FFBox's containers
are Ubuntu 22.04 with other font versions. Setting `FF_E2E_RUNNER` moves the job to other fonts, so re-render them there in
the same change. The first FFBox run is the one that tells whether they still match; if they do not, re-render them with
the `update_snapshots` input (the `linux-snapshots` artifact) and commit them. See the pull request that moved CI here.

## The future step: Windows, macOS and the VM tests

The workflows are ready for it (the variables above); the runners are not. What each would need:

- **Windows jobs** (`windows.yml`, `dev-drive.yml`, `worker-update.yml`): a self-hosted Windows runner that is not the
  determinism gate's. The only one the organisation has is `FinalFactory-Mode2-Windows-BEAST` (label
  `finalfactory-mode2-windows`), kept for the Final Factory nightly and deliberately label-locked so generic jobs stay off
  it. These jobs need a real elevated Windows with the virtual disk service and PowerShell 5 and 7, and a clean machine per
  run (the Dev Drive job makes and detaches a VHDX). A second Windows machine registered as an org runner, in a runner
  group that serves this repository, would do; the tests assume a throwaway user profile.
- **macOS** (`worker-update.yml`): a Mac registered as a runner, again clean per run. m3 and m5 are the machines the team
  works on, so a Mac used for CI would be one that nobody develops on. The job installs and updates a worker under launchd.
- **`vm-scripts.yml` `lint` and `e2e`**: root, systemd, nftables, libvirt and KVM, and the end-to-end job nests a VM. A
  runner container on FFBox has none of them. They need a privileged runner on the FFBox host itself (not a container), or
  a dedicated machine with `/dev/kvm`, registered as a runner with a label of its own, and a way to give each run an empty
  disk. The nightly production-timing job needs the same machine for about 50 minutes.
- **`ops-socket.yml`** could join `vm-scripts.yml`'s `lint` on that machine.
- **`rerun-lost-runner.yml`** re-runs the hosted Windows jobs GitHub loses; it goes when those do.

## Notes for the next person

- The artifact hand-off action (now `ci-actions/ffbox-handoff`) is `index.cjs`, not `index.js`: it was written here, where
  `package.json` says `"type": "module"`, which makes a `.js` file ESM and its `require` fail.
- The e2e server (`e2e/server.ts`) sets the host guard's disk thresholds low. A runner with less free space than the guard's 80 GB
  warning (an FFBox container's workspace has 56 GB) otherwise shows a "disk space is low" bar on every page, which shifts every
  screenshot 70 px and leaves a bar behind after a test dismisses its own.
