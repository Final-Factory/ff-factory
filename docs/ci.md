# CI: what fails and how to measure it

The workflows are `.github/workflows/`: `ci.yml` (typecheck, unit tests, web build, Playwright, gitleaks, commit
identities), `windows.yml` (the Windows-only tests, w910), `vm-scripts.yml` (shellcheck and dry runs, then the nested-VM
end to end), `worker-update.yml` (Windows and macOS installer runs) and `rerun-lost-runner.yml` (re-runs a job whose
runner was lost, once).

## What failed, 2026-09-26..10-10 (w922, measured)

373 failed or timed-out jobs (concurrency cancels left out): 37% real bugs, 36% flaky tests, 6% runner or mirror hangs,
21% lint, secret-scan and identity rules. 28% of pull-request head commits had at least one red job on the first try,
against 9% in FinalFactory, which runs one real check per commit where this repo runs about eight. The full table and the
plan are in w922's report.

Known causes, so a future failure can be named at once:

- **Windows, `coverage file is empty`**: Node's coverage on Windows; fixed in w906.
- **Playwright shard at 20 minutes in "Install browser system libraries"**: the Ubuntu mirror hung `apt-get update`
  (log ends at `azure.archive.ubuntu.com ... InRelease`). The step now gives up after 3 minutes and retries (w922).
- **A job shown "in progress" after it finished**: GitHub never marked it completed (5 times in 14 days, all "Commit
  identities are noreply"; on #294 the run sat 89 minutes until it was re-run). Re-run the run.
- **"Commit identities are noreply" on a manual run**: it checked main's 11 non-noreply commits of 2026-10-05/06 again;
  a manual run now checks only `origin/main..HEAD` (w922).
- **Nested VM: `error: Domain is already active`, `dataset is busy`**: the VM harness meeting the previous run's
  domain or zvol; flaky across branches.
- **gitleaks `generic-api-key` in a test or doc**: every one in the window was a fake key in a fixture; add it to
  `.gitleaksignore` or make the fixture not look like a key.

## Measuring

- The runs list caps a search at 1,000 results: `actions/runs?created=>=DATE` silently stops there (it reached back only
  4 of 14 days). Query one day at a time (`created=2026-10-06`) and page each.
- `runs/<id>/jobs?filter=all` gives every attempt's jobs, with the failing step's name.
- A failure that passed on the same commit and the same job name is flaky; a cancelled job whose run has a newer run on
  the same branch was cancelled by `concurrency` (on `main` too: 68 of 310 main commits never got a finished CI run).
- A job killed at its timeout keeps its log unless its runner was lost (`rerun-lost-runner.yml` tells the two apart).
