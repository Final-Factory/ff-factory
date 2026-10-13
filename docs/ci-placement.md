# Where CI runs

**Every ff-factory job runs on GitHub's hosted runners** (w1194, lothsahn 2026-10-13: "I'd like to move the ff-factory CI
processes off githubrunner and back to hosted githubrunner processes"). From w911 (2026-10-10) to w1194 the Linux jobs ran
on the FFBox build server's runner containers (`ffgithubrunners`); those now serve the game repository (FinalFactory) only.

| Workflow, job | Runs on | Why that runner |
|---|---|---|
| `ci.yml` `checks` (typecheck, unit tests with coverage, web build) | `ubuntu-latest` | Linux, Node; PowerShell 7 is in the image, so the scripts' `pwsh` tests run |
| `ci.yml` `e2e` (Playwright, Chromium and WebKit, 3 shards) | `ubuntu-latest` | the Linux screenshot baselines match its fonts (below) |
| `ci.yml` `secrets` (gitleaks), `identity` (noreply emails) | `ubuntu-latest` | Linux, git |
| `vm-scripts.yml` `plan` | `ubuntu-latest` | reads `git diff`; no API |
| `vm-scripts.yml` `lint` | `ubuntu-26.04` | the guest's release (D14): root, the installers' dry runs, `systemd-analyze verify` |
| `vm-scripts.yml` `e2e` | `ubuntu-24.04` and `ubuntu-26.04` | root, systemd, ZFS, libvirt and KVM: each nests a VM |
| `ops-socket.yml` (w638), only when its files change | `ubuntu-latest` | `sudo` and a running systemd |
| `rerun-lost-runner.yml` `rerun` (w906) | `ubuntu-latest` | calls the API itself with its own `GITHUB_TOKEN` (`actions: write`) |
| `windows.yml`, `dev-drive.yml`, `worker-update.yml` (Windows) | `windows-latest` | Windows: elevated, the virtual disk service, PowerShell 5 and 7 |
| `worker-update.yml` (macOS) | `macos-latest` | macOS, launchd |

Actions are the standard ones, pinned by commit: `actions/checkout`, `actions/setup-node` (with the npm cache),
`actions/upload-artifact`. gitleaks comes from its release, checked against the release's checksums file
(`.github/actions/gitleaks`); Playwright's browsers from `npx playwright install --with-deps`.

## Cost

**Nothing.** The repository is public (measured: `gh api repos/Final-Factory/ff-factory`, `visibility: public`), and GitHub's
billing page says "GitHub Actions usage is free for self-hosted runners and for public repositories that use standard
GitHub-hosted runners" (sourced: docs.github.com, GitHub Actions billing). Every label above is a standard runner. The
organisation's usage report could not be read to confirm it: the agents' fine-grained token gets a 403 there.

What it would cost if the repository went private: the CI jobs alone used about 13,000 Linux minutes in the 30 days measured
for w1167 (Actions API, 2026-09-12 to 2026-10-12, mostly before w911 moved them: Playwright 8,339, checks 2,645, secrets
1,009, identity 1,003), about $78 a month at $0.006 a Linux minute (GitHub's January 2026 price), before the plan's included
minutes and the VM, Windows and macOS jobs.

**What it does cost is concurrency**: 20 hosted jobs at once for the whole organisation on the free plan, 5 of them macOS
(sourced: docs.github.com, Actions limits). A pull request that touches everything starts about a dozen jobs (checks, three
Playwright shards, secrets, identity, the VM plan, lint and end-to-end jobs, Windows), so several such pull requests at once
queue. The game repository asks only for self-hosted labels and takes none of them.

## Fork pull requests

A fork's pull request runs the same jobs on hosted runners, as is normal for a public repository. That is safe because:

- every workflow triggers on `pull_request`, never `pull_request_target`, so a fork's run gets a read-only `GITHUB_TOKEN`
  and no secrets (GitHub's rule for fork pull requests), and no job here reads a secret;
- a first-time contributor's run waits for an owner's approval (Settings, Actions, General);
- `rerun-lost-runner.yml` runs on `workflow_run`, from main with main's token, but checks out no code: it reads the run's
  jobs and re-runs the failed ones once.

Keep it that way: a job that needs a secret must not run on a fork's `pull_request`, and nothing here may use
`pull_request_target` to check out a pull request's code.

## The visual baselines

`e2e/__screenshots__/*-linux.png` match one machine's fonts: `ubuntu-latest`'s. When they stop matching (a new runner image,
a font change), re-render them with the `update_snapshots` input (`gh workflow run ci.yml --ref <branch> -f
update_snapshots=true`), download the `linux-snapshots` artifact, and commit it in the same change.

## No performance or load tests

CI runs no perf, load or timing tests (lothsahn, 2026-10-12, w1173: "We don't want load or performance tests in the ff
factory CI pipeline"). Agents run `npm run perf` locally (CONTRIBUTING.md, "Performance").

## Notes for the next person

- The e2e server (`e2e/server.ts`) sets the host guard's disk thresholds low. A runner with less free space than the guard's
  80 GB warning otherwise shows a "disk space is low" bar on every page, which shifts every screenshot 70 px and leaves a bar
  behind after a test dismisses its own.
- What FFBox's runners could and could not do for this repository (w911, w1102, w1167: no systemd, no `/dev/kvm`, an egress
  fence without github.com) is in this file's history before w1194, and in ffbox `runners/README.md`.
