# The daily merge-gate tuning (w4928)

lothsahn, w4928: "I would like to build a daily job that analyzes which tests get missed in the merge gate and only caught
in the CI run. These tests should get pulled into the merge gate. And if tests have run a lot and not failed in the merge
gate, consider moving them to the full ci run".

`server/gateTuning.ts` (`GateTuningJob`, started in `server/index.ts`) reads the per-test history
([test-history.md](test-history.md)); it keeps no store of its own. Its state is the `gate_tuning` table and two `meta`
keys in the same `<dataDir>/test-history.db`.

## When it runs

It checks every 30 minutes, first 90 s after a start. It is due when:

- it has never run;
- or no row exists for today and the UTC hour is past `gateTuning.hourUtc` (default 9, after the night's batches);
- or today's filing was left pending.

A dry run (`server/dryRun.ts`) runs nothing. `gateTuning.enabled: false` turns it off, and so does the history's own off
switch (`testHistory.enabled`).

## 1. Tests the gate missed: pulled in

A **miss** is a failure the master batch labelled `detect`: its bisect named the merge that broke it ("master batch: the
bisect named the merge that broke it: PR #N (sha9)"). There is one miss per test class and culprit PR. Flakes (`fp`) and
`unknown` failures are not misses, and neither is any Performance-tagged test.

For each miss it finds the culprit PR's last gate run before the catch that still has results, matched by `runs.pr`, the
PR's head sha, or its head branch (`gh api repos/<repo>/pulls/<n>`). The verdict is one of:

- `not-in-gate`: that gate ran without the class. This is a real miss.
- `gate-ran-passed`: the gate ran it and it passed there, so it failed only on master (an interaction, or a merge race).
  Pulling it in would change nothing, so these are listed and not filed.
- `no-gate-record`: no gate run of that PR is recorded (older than the history, or the results' 60 days are past).
  These are filed, and the worker's `check` decides.

New misses (not yet handled, not `gate-ran-passed`) are filed as **one request a day**:

- source `master-batch`, kind `gate-miss`, key `master-batch:gate-miss:<day>`;
- triage `follow-up`, priority normal;
- auto-approved unless `gateTuning.autoApprove.enabled` is false, at most `maxPerDay` (default 1) a day, counting only
  gate-miss filings.

The worker follows the game repo's `scripts/gate_tuning.py`:

1. `check --pr N --test C` says IN or MISSED.
2. `pull-in --pr N --test C` adds the class to `.github/merge-gate-pulled-in.json` for the folders of the code that broke
   it. `.github/scripts/merge-gate-tests.py` then runs it on any PR that touches those folders.
3. One PR is opened and merged on a green Test in editmode.

The worker rules (`server/intakeRules.ts` `workerRules`) forbid loosening a threshold, touching a Performance test, taking
a test out of the gate, and renaming CI's required checks.

**The baseline.** The first run records the highest failure id it saw as `meta.gate_tuning_baseline`. Misses up to that
id are listed as "baseline" and never filed: a deploy files nothing for old history. `meta.gate_tuning_handled` is the
last failure id it acted on. A filing that could not be made (no orchestrator, the daily cap) leaves the day pending, and
it is tried again on the next check.

## 2. Tests proposed to move out of the gate (proposals only)

A class is **proposed** for moving from the gate to the post-merge full suite when it meets every part of `OUT_RULE` in
the last 90 days:

| Rule | Value | Why |
|---|---|---|
| Share of gate runs it ran in | ≥ 95% | it is effectively always-run (a repo-wide check), so moving it saves time on every PR |
| Gate runs | ≥ 300 | rule of three (Hanley & Lippman-Hand, JAMA 1983): 0 failures in n runs gives a 95% upper bound of 3/n on its failure rate, so ≤ 1% at 300 |
| Span since first gate run | ≥ 14 days | so a burst of PRs on one day does not count as a long record |
| Gate failures of any label | 0 | one real or flaky failure there means it is doing something there |
| `detect` in any source | 0 in 90 days | it has caught nothing, gate or batch |
| Performance-tagged | never | they run in no CI |

A class's runs are the distinct gate runs that ran it (`results`), not the `test_days` count: a parameterized case repeats its name in one run, and the first run (2026-11-21) proposed `NarrationClipsTest` at "3224 runs" when it ran in 105 of 873.

Each proposal carries its gate runs, share, first day, span, time per run and total, the 95% bound, and `crown_jewel`. That
flag is set for a class name matching `Serializ|Save|Determinis|Desync|Lockstep|Heartbeat|Multiplayer|Netcode|Network|PerFrame|LocalToWorld|UpgradeStep|Golden|Fingerprint`:
a determinism or save guard, never moved without a person's explicit yes. The job moves nothing: removing a test from the
gate is a person's decision, made in the game repo (`merge-gate-tests.py` `repo_wide_checks`).

"Gate time saved" is the sum of the non-crown-jewel proposals' time per run, times gate runs a day. That is CPU time
inside the test run; a gate run's compile and set-up stay.

## 3. The daily summary

`test_history {query: "gate_tuning"}` answers the newest day's summary as its title (gate runs, misses and their verdicts,
what was filed, proposals and time saved), with the proposals as rows, most gate time first. The `gate_tuning` table has
one row per day: `(day, at, summary, json)`, where `json` is the whole result (`GateTuning` in `server/gateTuning.ts`).
Read older days with `{query: "sql", sql: "SELECT day, summary FROM gate_tuning ORDER BY day DESC"}`.

## Config

`gateTuning: { enabled?: boolean; hourUtc?: number; autoApprove?: { enabled?: boolean; maxPerDay?: number } }`, read at
every check.

| Key | Default |
|---|---|
| `enabled` | on |
| `hourUtc` | 9, clamped to 0 to 23 |
| `autoApprove.enabled` | on |
| `autoApprove.maxPerDay` | 1, at most 10 |

## Tests

`server/gateTuning.test.ts` covers:

- the three verdicts;
- the baseline, one filing a day, and a miss never filed twice;
- a pending filing being tried again;
- the proposal rule (share, runs, a gate failure, Performance, crown-jewel flag);
- the query, the identity key and the worker rules.
