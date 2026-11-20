# The per-test history (w4922)

lothsahn, w4922: "This should be built as a query able database so that we can look at which tests false positive the
most and fix them. And we can look at which tests never catch real bugs to consider removing tests that don't provide any
real coverage." And: "it should be stored on the portal and something the workers must update as they run tests. Please
built it into the harness so it's not just a rule that workers may forget to do."

The portal keeps every run of the game repo's tests in one SQLite database, `<dataDir>/test-history.db`
(`server/testHistory.ts`). For each run it records which tests passed and failed, how long they took, and what each
failure turned out to be. Nobody records anything by hand. Orchestrators and workers query it with the `test_history`
tool. The game repo's side is `Documentation/Test-History.md` there.

## Where the runs come from

| Source (`runs.source`) | What | How it arrives |
|---|---|---|
| `pr-gate` | the merge gate's `Test in editmode` on a pull request: the selected EditMode tests | `server/testHistoryCi.ts` downloads the run's "Test results for editmode" artifact (`editmode-results.xml`) |
| `release` | the same job on a push to master (a version bump): the whole EditMode suite | the same artifact, on a `push` run |
| `ci-other` | that job on any other event (a dispatch) | the same |
| `master-batch` | `master-batch.yml`: the whole suite at the batch tip, and the PlayMode smoke test | the "Master batch results" artifact: `00-full.xml`, `00-full-smoke.xml`, `verdict.json`, `coverage.json` |
| `local` | a worker's run in its sandbox's editor (MCP `run_tests`, the Test Runner, a batch `-runTests`) | the game repo's `Assets/Editor/TestHistoryRecorder.cs` writes `Library/FFTestHistory/*.json`; the daemon (`machine/testHistorySpool.ts`) sends each file as `test_history`, and the portal tags it with the machine, sandbox, live workers and their requests, answers `test_history_ack`, and the daemon deletes the file |

- **The CI collector** reads every 5 minutes, with the system payer's GitHub token, as the master batch watch does.
  - Each look downloads at most 12 artifacts, newest first.
  - It goes back `testHistory.backfillDays` (21, at most 90; `set_app_config`).
  - It never reads an artifact twice (`ci_seen`) and gives one up after 3 failed tries.
  - It changes nothing in CI and needs no new credential or FFBox setting.
  - The only CI cost is `coverage.json` in the master batch, 1.2 to 5.3 s per batch (measured).
- **A master batch keeps only its failures in `results`.** At about 22,000 cases, some 30 times a day, its passes live in
  `test_days` only.
- **Not included:**
  - **Nightly e2e:** its intake keeps only the failing and flaky scenarios of a night (`server/nightlyRules.ts`
    `NightlyReport`), with no passes or times.
  - **ffu's cargo tests:** another repo, with its own runners.

## Labels

Every failure gets one label (`failures.label`). The labeller (`labelFailures`) runs after every CI look. An automatic
label never replaces one a person or worker set.

- **`fp` (false positive):**
  - the test passed again with nothing changed: a re-run at the same commit, the master batch's confirm run (its
    `flaky` list), or a local re-run with the same files;
  - or it passed after only test files or files outside the game changed (`Assets/Tests`, `Assets/TestsSlow`,
    `Assets/Scripts/PlayModeTests`, any `/Tests/` folder, `scripts/`, `.github/`, docs).
- **`detect` (correct failure detection):**
  - the master batch's bisect named the merge that broke it (`culprits`);
  - or the test passed again after only game code changed (`Assets/` outside the test folders, `Packages/`,
    `ProjectSettings/`).
- **`unknown`:**
  - both tests and game code changed;
  - the batch could not pin the failure (`unresolved`), or named it in no list;
  - a local run's branch base moved (origin/master was merged in);
  - more than 300 files changed;
  - or the test did not pass again on its line within 7 days.

  The labeller never guesses.
- **pending** (`label IS NULL`): not decided yet.

**What "passed again" and "what changed" mean, by source:**

- **A pull request's line** is its branch. A later CI run of the same branch is the next run (master batches excluded).
  What changed is the difference between the PR's own diff against master at the two heads, file by file, from GitHub's
  compare.
- **A local line** is one machine, sandbox and branch. What changed is the difference between the two runs'
  fingerprints. Each run records every path that differs from the merge base with origin/master, with its blob hash.
- **The master batch** labels its own failures from `verdict.json`.

## The tables

- `tests(id, name, class, categories, performance, first_seen, last_seen)`: `performance` = tagged
  `[Category("Performance")]`. The ready-made queries leave these tests out unless `performance: true`.
- `runs(id, source, key, repo, ci_run, attempt, sha, base, pr, branch, machine, sandbox, requests, sessions, started,
  finished, mode, tests, passed, failed, skipped, total_ms, verdict, changes, url, recorded)`: `requests` and `sessions`
  are comma lists.
- `results(run_id, test_id, outcome, ms)`: kept 60 days, longer for a run with pending failures; a master batch's
  failures only.
- `test_days(day, source, test_id, runs, passes, fails, total_ms, max_ms)`: the rollup the queries count, kept 365 days.
- `failures(id, run_id, test_id, message, label, reason, labelled_by, labelled_at)`: kept for good.
- `coverage(class, type)`: each test class and the production types its file names, from the newest master batch's
  `coverage.json` (`scripts/test_select.py`).
- `meta(k, v)`: `recorded_since`, `ci_oldest`, `coverage_sha`.

## Querying

The `test_history` tool is read-only. Orchestrators (dispatcher, personal, remote) and workers have it (group `ledger`).

| Call | Answers |
|---|---|
| `{query: "summary"}` | runs per source, labels, since when |
| `{query: "slowest", limit: 10}` | slowest by average time |
| `{query: "false_positives", byRate: true, minRuns: 5, limit: 10}` | most false positives by rate (leave out byRate for count) |
| `{query: "detections", limit: 10}` | most correct detections |
| `{query: "never_caught", days: 30, limit: 20}` | tests with no `detect` in the window, ranked by total run time, with run count, first seen and the types their class covers |
| `{query: "failures", label: "pending"}` | failures, newest first, with machine, sandbox and request |
| `{query: "test", test: "BeltTest"}` | one test's runs per day and source |
| `{query: "sql", sql: "SELECT ..."}` | one read-only SELECT (or WITH), at most 200 rows, stopped after 10 s |

`sources` limits any query to some sources (`["pr-gate", "master-batch"]`), and `days` sets the window (30).

**`never_caught` only suggests.** A test that caught nothing in a month may still guard something rare. Read
`first_seen`: a test recorded for a week has had little chance. Removing or changing a test is a person's decision.

Example SQL:

```sql
-- the false-positive rate per test class over the last 30 days, gate and batch only
SELECT t.class, sum(f.label = 'fp') AS fp, (SELECT sum(runs) FROM test_days d JOIN tests x ON x.id = d.test_id
  WHERE x.class = t.class AND d.day >= date('now', '-30 days')) AS runs
FROM failures f JOIN tests t ON t.id = f.test_id JOIN runs r ON r.id = f.run_id
WHERE r.finished >= date('now', '-30 days') AND r.source IN ('pr-gate', 'master-batch')
GROUP BY t.class ORDER BY fp DESC LIMIT 20

-- what one request's local runs ran
SELECT finished, sandbox, tests, passed, failed, total_ms FROM runs WHERE source = 'local' AND ',' || requests || ',' LIKE '%,w4922,%'

-- the merge gate's time per pull request
SELECT pr, count(*) AS runs, round(sum(total_ms) / 60000.0, 1) AS minutes FROM runs WHERE source = 'pr-gate' GROUP BY pr ORDER BY minutes DESC LIMIT 10
```

**Setting a label by hand:** nothing writes through the tool. A person's correction goes to an orchestrator, which asks
the ops worker to call `TestHistory.label(id, label, reason, by)` on the portal. An automatic label never overwrites it.
