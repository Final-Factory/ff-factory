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
| `ci.yml` `ops-socket` (w638) | hosted `ubuntu-latest` | `sudo` and a running systemd |
| `vm-scripts.yml` `lint`, `e2e` | hosted | root, systemd, libvirt, KVM (the end-to-end jobs nest a VM) |
| `windows.yml`, `dev-drive.yml`, `worker-update.yml` (Windows) | hosted `windows-latest` | Windows |
| `worker-update.yml` (macOS) | hosted `macos-latest` | macOS |
| `rerun-lost-runner.yml` | hosted | it re-runs hosted Windows jobs GitHub lost, through the API |

## What a job on FFBox can and cannot do

A runner container is single-use, runs as root with every capability dropped, and sits behind an egress fence.

- **Reaches from outside:** the npm registry and GitHub's Actions service. **Never `github.com` or `api.github.com`**: an
  SNI fence cannot limit those to one repository, so one POST to `/gists` with a credential lifted out of a test would
  leave through it. A job that needs a fact from GitHub asks the host (ffbox `scripts/ci_lane.py` `serve_github`).
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
- **The repository is public and the runners are shared with private repositories.** Fork pull requests need an
  owner's approval before any job runs (Settings, Actions, General, "Require approval for all external contributors"),
  and no FFBox job holds a secret.

## The visual baselines

`e2e/__screenshots__/*-linux.png` were rendered on GitHub's `ubuntu-latest`; FFBox's containers are Ubuntu 22.04 with other
font versions. The first FFBox run is the one that tells whether they still match; if they do not, re-render them with
the `update_snapshots` input (the `linux-snapshots` artifact) and commit them. See the pull request that moved CI here.

## The future step: Windows, macOS and the VM tests

None of this moved. What each would need:

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
- **`ops-socket`** could join `vm-scripts.yml`'s `lint` on that machine.
- **`rerun-lost-runner.yml`** is about hosted Windows runners GitHub loses; it goes when those do.

## Notes for the next person

- The artifact hand-off action is `index.cjs`, not `index.js`: this repository's `package.json` says `"type": "module"`, which
  makes a `.js` file ESM and the action's `require` fail with "require is not defined in ES module scope".
- The e2e server (`e2e/server.ts`) sets the host guard's disk thresholds low. A runner with less free space than the guard's 80 GB
  warning (an FFBox container's workspace has 56 GB) otherwise shows a "disk space is low" bar on every page, which shifts every
  screenshot 70 px and leaves a bar behind after a test dismisses its own.
