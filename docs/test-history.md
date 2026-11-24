# The per-test history (w4922)

lothsahn, w4922: "This should be built as a query able database so that we can look at which tests false positive the
most and fix them. And we can look at which tests never catch real bugs to consider removing tests that don't provide any
real coverage." And: "it should be stored on the portal and something the workers must update as they run tests. Please
built it into the harness so it's not just a rule that workers may forget to do."

The portal keeps every run of the game repo's tests in one SQLite database, `<dataDir>/test-history.db`
(`server/testHistory.ts`). For each run it records which tests passed and failed, how long they took, and what each
failure turned out to be. No agent records a run: every run gets in by code alone (lothsahn, w4922: "I don't want ai
agents having to remember or do work to ensure the runs appear" and "the actual test executions should be ingested
deterministically with every work order"). Orchestrators and workers query it with the `test_history` tool, and may add a
label by hand, recorded as theirs. The game repo's side is `Documentation/Test-History.md` there.

## Where the runs come from

| Source (`runs.source`) | What | How it arrives |
|---|---|---|
| `pr-gate` | the merge gate's `Test in editmode` on a pull request: the selected EditMode tests | `server/testHistoryCi.ts` downloads the run's "Test results for editmode" artifact (`editmode-results.xml`) |
| `release` | the same job on a push to master (a version bump): the whole EditMode suite | the same artifact, on a `push` run |
| `ci-other` | that job on any other event (a dispatch) | the same |
| `master-batch` | `master-batch.yml`: the whole suite at the batch tip, and the PlayMode smoke test | the "Master batch results" artifact: `00-full.xml`, `00-full-smoke.xml`, `verdict.json`, `coverage.json` |
| `local` | any run of the Unity test runner on a worker machine (MCP `run_tests`, the Test Runner window, a batch `-runTests`, `MergeGateTestRunner`), in a sandbox or any other project | the game repo's `Assets/Editor/TestHistoryRecorder.cs` writes `$FF_WORKER_ROOT/test-history/*.json` (else the project's `Library/FFTestHistory/`); the daemon (`machine/testHistorySpool.ts`) sends each file as `test_history`, the portal tags it with its request (below), answers `test_history_ack`, and the daemon deletes the file |

- **The CI collector** reads every 5 minutes, with the system payer's GitHub token, as the master batch watch does.
  - Each look downloads at most 12 artifacts, newest first.
  - It goes back `testHistory.backfillDays` (21, at most 90; `set_app_config`).
  - It never reads an artifact twice (`ci_seen`) and gives one up after 3 failed tries.
  - It changes nothing in CI and needs no new credential or FFBox setting.
  - The only CI cost is `coverage.json` in the master batch, 1.2 to 5.3 s per batch (measured).
- **A local run is on disk from its start.** The recorder writes `<name>.running.json` when the run starts and rewrites
  it at most once a minute as tests finish; the finished run replaces it with `<name>.json`. A running file untouched for
  2 hours (`STALE_MS`: the editor crashed, was killed, or a batch run died) is sent as it is, and the run is recorded with
  `verdict` "incomplete: N of M tests finished", even with no test finished. A run's two files share one key, so it is
  recorded once.
- **Every local run carries its request, or says it has none** (`runs.tagged`, `localRunTags`):
  - `session`: the record names the worker session that started it (`FF_SESSION_ID` of a worker's shell, or its temp
    folder `ffa-<session>`), a batch run's case; tagged with that session's requests;
  - `sandbox`: an editor run in a sandbox with one live worker as the run started: that worker and its requests;
  - `shared`: several live workers in that sandbox: all of them and all their requests;
  - "as the run started": the daemon announces a running file at first sight (`test_history_started`, within a minute
    of the run's start) and the portal keeps the sandbox's workers then (`run_starts`, `noteStart`); the finished
    record uses them, so a run whose record comes after its worker left the sandbox (stopped on a wait for CI, moved to
    other work, an incomplete run sent two hours later) keeps its request. Without a start (an older daemon, a run
    shorter than the daemon's minute) the workers when the record comes count;
  - `none`: no worker known (a person's own run, a project outside any sandbox with no session). `{query: "local_runs",
    untagged: true}` lists them.

  The daemon names a record's sandbox from its `project` path when the file came from the machine's spool, and leaves it
  empty for a project outside every sandbox (a temp worktree).
- **A master batch keeps only its failures in `results`.** At about 22,000 cases, some 30 times a day, its passes live in
  `test_days` only.
- **Not included:** the routes below marked no.

### Every route a test can be run by

| Route | Recorded | How, and the tag |
|---|---|---|
| MCP `run_tests` in a sandbox's editor | yes | recorder, machine spool; tagged `sandbox` (or `shared`) |
| The Test Runner window in a sandbox's editor | yes | the same |
| A batch `-runTests` under `unity-slot run`, with or without `-testResults` | yes | recorder (TestRunnerApi callbacks fire in batch mode); tagged `session` from the worker shell's `FF_SESSION_ID` |
| `MergeGateTestRunner` (the gate's list, locally) | yes | the same, as an editor or batch run |
| An editor or batch run in a temp worktree or clone in `$TMPDIR` | yes | machine spool (`FF_WORKER_ROOT`), no sandbox; tagged `session` when a worker's shell started it, else `none` |
| A run cut short (crash, kill, a hung editor restarted) | yes, as incomplete | the running file, after 2 hours |
| The PR gate's `Test in editmode` | yes | its artifact (`pr-gate`) |
| The master batch, full suite and PlayMode smoke | yes | its artifact (`master-batch`) |
| A release push's EditMode run | yes | its artifact (`release`) |
| A person's own editor outside FF Factory (no `FF_WORKER_ROOT`, not in a sandbox) | no | its file stays in that project's `Library/FFTestHistory/`, which no daemon reads |
| The game repo's `scripts/tests` (Python unittest), locally or in CI | no | not a Unity run; a recorder is separate work |
| FF Factory's own `npm test` | no | separate work |
| ffu's `cargo test` | no | another repo, its own runners; separate work |
| The nightly e2e | no | its intake keeps only a night's failing and flaky scenarios (`server/nightlyRules.ts` `NightlyReport`), with no passes or times |

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
  - a local run where the failing test's own source file (`<Class>.cs`) was dirty in the run's changes, or differed
    between the failing and the passing run: the worker was writing or editing that test, so its pass says nothing about
    flakiness (w5457: one such run gave all 4 tests of PanelsHiddenHintTest a 1-of-32 "flake");
  - a failure that took over 100 times the test's median passing time (at least 5 passes; median counted as 50 ms at
    least): the run stalled, as an editor does under machine load (w5457);
  - or the test did not pass again on its line within 7 days.

  Known gap (w5457): a local failure from stale state (an asset reverted without a re-import, a probe built before
  recompiling) changes no file, so it still reads as "nothing changed" and stays `fp`; the runs record nothing that tells
  it apart. A worker relabels such a failure by hand (`set_label`). Labels already written are not recomputed: the
  labeller only decides pending failures.

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
- `runs(id, source, key, repo, ci_run, attempt, sha, base, pr, branch, machine, sandbox, requests, sessions, tagged,
  started, finished, mode, tests, passed, failed, skipped, total_ms, verdict, changes, url, recorded)`: `requests` and
  `sessions` are comma lists; `tagged` is how a local run's request was found (above); `verdict` starts "incomplete" for
  a run that never finished.
- `results(run_id, test_id, outcome, ms)`: kept 60 days, longer for a run with pending failures; a master batch's
  failures only.
- `test_days(day, source, test_id, runs, passes, fails, total_ms, max_ms)`: the rollup the queries count, kept 365 days.
- `failures(id, run_id, test_id, message, label, reason, labelled_by, labelled_at)`: kept for good. `labelled_by` is
  `auto`, `worker:<session>` or `person:<name> (<role> <session>)`.
- `coverage(class, type)`: each test class and the production types its file names, from the newest master batch's
  `coverage.json` (`scripts/test_select.py`).
- `meta(k, v)`: `recorded_since`, `ci_oldest`, `coverage_sha`, and the gate tuning's `gate_tuning_baseline` and
  `gate_tuning_handled`.
- `gate_tuning(day, at, summary, json)`: the daily merge-gate tuning's result, one row a day ([gate-tuning.md](gate-tuning.md)).

## Querying

Orchestrators (dispatcher, personal, remote) and workers have the `test_history` tool (group `ledger`). Every query reads
only; `set_label` is its one write.

| Call | Answers |
|---|---|
| `{query: "summary"}` | runs per source, labels, since when |
| `{query: "slowest", limit: 10}` | slowest by average time |
| `{query: "false_positives", byRate: true, minRuns: 5, limit: 10}` | most false positives by rate (leave out byRate for count) |
| `{query: "detections", limit: 10}` | most correct detections |
| `{query: "never_caught", days: 30, limit: 20}` | tests with no `detect` in the window, ranked by total run time, with run count, first seen and the types their class covers |
| `{query: "failures", label: "pending"}` | failures, newest first, with machine, sandbox and request |
| `{query: "test", test: "BeltTest"}` | one test's runs per day and source |
| `{query: "local_runs", request: "w4922"}` | one request's local runs, with how each was tagged and any incomplete verdict; `untagged: true` for the runs with no request |
| `{query: "set_label", failureId: 123, label: "fp", reason: "passed on a re-run at the same commit"}` | a hand label (below) |
| `{query: "gate_tuning"}` | the daily merge-gate tuning's newest summary: tests the gate missed and what was filed to pull them in, and the always-run checks proposed to move out, with runs, span, time and the crown-jewel flag ([gate-tuning.md](gate-tuning.md)) |
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

## Labels by hand

lothsahn, w4922: "I realize some notes and classifications may come workers." A worker or an orchestrator may label a
failure with `set_label` (`failureId` from `{query: "failures"}`, `label` fp, detect or unknown, and a `reason`). The
portal records who set it in `labelled_by`, from the caller, never from the arguments (`Agents.testHistoryText`):

- a worker: `worker:<session>`;
- an orchestrator: `person:<its person> (<role> <session>)`; the dispatcher, which has no one person, `person:unconfirmed
  (dispatcher <session>)`.

Ranks: the labeller (`auto`) < a worker < a person. A label replaces one of the same or a lower rank, so the labeller never
replaces a hand label and a worker never replaces a person's. `false_positives` and `detections` show `by_worker` and
`by_person`, the counts set by hand; `labelled_by = 'auto'` in SQL keeps only the labeller's.
