# CI: what fails and how to measure it

The workflows are `.github/workflows/`: `ci.yml` (typecheck, unit tests, web build, Playwright, gitleaks, commit
identities), `windows.yml` (the Windows-only tests, w910), `vm-scripts.yml` (shellcheck and dry runs, then the nested-VM
end to end), `worker-update.yml` (Windows and macOS installer runs), `rerun-lost-runner.yml` (re-runs a job whose
runner was lost, once) and `ops-socket.yml` (the ops worker's socket under real systemd, only when deploy/vm/guest/units/fff-ops.socket,
the launcher, its test, server/opsWorker.ts or the lockfiles change, and weekly; w1102).

**What runs where** (w925, lothsahn: "3B"): a pull request runs the whole suite. A push to `main` runs only the secret
scan and the identity check, each push in its own concurrency group so a later merge never cancels it, the way
FinalFactory's `master` works (w1137: its one trunk; `develop` is retired). There is no branch protection or ruleset; the
portal's `ci:` gate and CI-read health read pull-request heads (`server/blockerWatch.ts`, `server/ciReadHealth.ts`), and
`fffctl update` by hand builds `origin/main` without asking CI (`deploy/vm/guest/fff-update`). The one reader of `main`'s
CI is the portal's automatic deploy (w1634, [ops-worker.md](ops-worker.md) "Automatic deploys"): it deploys a commit only
once its push runs and its pull request's runs have finished green. Still on `main`: the nightly VM
run and the daily whole Windows suite (schedules). The whole suite on `main` by hand: `gh workflow run ci.yml --ref
main` (likewise `vm-scripts.yml`, `windows.yml -f all=true`, `worker-update.yml`, `dev-drive.yml`).

## What failed, 2026-09-26..10-10 (w922, measured)

373 failed or timed-out jobs (concurrency cancels left out): 37% real bugs, 36% flaky tests, 6% runner or mirror hangs,
21% lint, secret-scan and identity rules. 28% of pull-request head commits had at least one red job on the first try,
against 9% in FinalFactory, which runs one real check per commit where this repo runs about eight. The full table and the
plan are in w922's report.

Known causes, so a future failure can be named at once:

- **Windows, `coverage file is empty`**: Node's coverage on Windows; fixed in w906.
- **Playwright shard at 20 minutes in "Install browser system libraries"**: the Ubuntu mirror hung `apt-get update`
  (log ends at `azure.archive.ubuntu.com ... InRelease`). The step gives up after 4 minutes and tries once more (w922;
  w1194's move back to GitHub's runners lost it and w1758 put it back: 3 WebKit jobs hung there on 2026-10-22).
  `scripts/e2e-legs.test.ts` fails a ci.yml whose browser install has no time limit or no second try.
- **A job shown "in progress" after it finished**: GitHub never marked it completed (5 times in 14 days, all "Commit
  identities are noreply"; on #294 the run sat 89 minutes until it was re-run). Re-run the run.
- **"Commit identities are noreply" on a manual run**: it checked main's 11 non-noreply commits of 2026-10-05/06 again;
  a manual run now checks only `origin/main..HEAD` (w922).
- **Nested VM, `error: Domain is already active`** at "10/12" of the second host install (7 in 14 days, all on the
  ubuntu-26.04 zvol host): `dom_state` piped `virsh domstate` into `head -n 1`; virsh writes its blank line in a second
  write, died of SIGPIPE when head had gone, pipefail made the answer "running" and "missing", and install.sh started the
  running VM. Not leftover state: every job has a fresh runner. Fixed in w759 (7b8ec37); against a fake virsh the old
  `dom_state` misread a running VM 147 times in 500, the new one 0 in 500 (w926, measured).
- **Nested VM, `cannot destroy 'fffci/fff-vm/disk0': dataset is busy`** at uninstall's "3/6 the disk" (5): the zvol stays
  busy a moment after QEMU lets it go; uninstall.sh now settles udev and tries for a minute (w537, 9843221).
- **Unit tests that failed only on a slow or loaded runner**, all fixed by 2026-10-09 (w926 checked every failure's commit
  against its fix: none came after it):
  - `durable.test.ts` "a steady stream of changes cannot postpone the write", `a recent version (2 of 100)` (9, Windows): a
    fixed 700 ms read while a slow fsync held the write (w636, f700b15). `durable.test.ts` also runs it with a 500 ms fsync
    on Linux, where the old test failed 40 of 40.
  - `machines.test.ts` "a bad token is refused", `the portal is unreachable right now` (3, Windows): the token file's
    fsync held up the daemon's 101 (w568, 3d56a5b). "a daemon stopping on purpose ... not redeployed", `[ 'mx' ]` (3): a
    reconnect in flight ended the hold (w513, e538e3e). "a portal answering 502", `generated asynchronous activity after
    the test ended ... read ECONNRESET` shown against the whole file (6): the fake portal had no handler for the daemon's
    reset (w753, 9db5f79).
  - `unitySlots.test.ts` crashed holder, dropped waiter and the CLI run (12, Windows): a 200 ms stale limit or 150 ms head
    start that a runner's stall reached (w636, f700b15). The "goes over its limit" failure (2, Linux, w469's own branch)
    was a real bug fixed before it merged, not a flake.
- **gitleaks `generic-api-key` in a test or doc**: every one in the window was a fake key in a fixture; add it to
  `.gitleaksignore` or make the fixture not look like a key.

## Before you push

`npm run prepush` (`scripts/prepush.ts`, w924) runs the typecheck, `deploy/vm/test/lint.sh --shellcheck-only`, gitleaks
on `origin/main..HEAD` and `scripts/check-identity.ts origin/main..HEAD`: 13.5 s on biscuit (measured). A missing
shellcheck or gitleaks (or bash, on Windows) skips that step with a `SKIPPED` line instead of failing; install them
(the package manager, or the release binaries) to
get the whole check. No git hook is installed: a sandbox is a worktree, so a hook would land in the hooks folder every
worktree and the person's own clone share, and would run on pushes nobody asked it for. `scripts/prepush.test.ts` plants a
shellcheck finding, a fake key and a personal email, and fails if the check misses any.

## Ports in tests

`node --test` runs the test files in parallel, so a port one test frees goes to the next one that asks. A server a test
starts listens on port 0 and reads its port back (`server.address()`); a portal it spawns does the same with `port: 0` in
its config and says the port in its log ("on http://127.0.0.1:<port> ", `server/index.ts`). A port that must be known
before the process starts, or kept across its restarts, comes from `reservePort` (`server/testPorts.ts`): below the OS's
ephemeral range, locked per process, checked free. Never listen on 0, close, and hand the number on: that is how
`crashRecovery.test.ts` died with EADDRINUSE on PR #335 (w1095). `server/testPorts.test.ts` fails on that pattern.

## Measuring

- The runs list caps a search at 1,000 results: `actions/runs?created=>=DATE` silently stops there (it reached back only
  4 of 14 days). Query one day at a time (`created=2026-10-06`) and page each.
- `runs/<id>/jobs?filter=all` gives every attempt's jobs, with the failing step's name.
- Before calling a failure a live flake, check its commit holds the newest fix to that test or script:
  `git merge-base --is-ancestor <fix> <failing sha>` (fetch `refs/pull/*/head` for deleted branches). w922's 14-day
  counts for machines, durable, unitySlots and the VM harness were all from commits before their fixes (w926).
- The REST budget is 5,000 calls an hour, shared by every agent on the account: w926's census (each day's runs, then
  `jobs` and `logs` for each) spent all of it in about 20 minutes and refused everyone's calls until the hour turned. Fetch
  only the runs you need (`?status=failure`, one workflow), keep the results in a file, and check
  `gh api -i repos/<repo> | grep -i x-ratelimit-remaining` (the `rate_limit` endpoint itself can read 5000 while it is 0).
- A failure that passed on the same commit and the same job name is flaky; a cancelled job whose run has a newer run on
  the same branch was cancelled by `concurrency` (on `main` too: 68 of 310 main commits never got a finished CI run).
- A job killed at its timeout keeps its log unless its runner was lost (`rerun-lost-runner.yml` tells the two apart).
