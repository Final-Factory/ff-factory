- **The merge gate is tuned from the test history once a day** (w4928; docs/gate-tuning.md). `server/gateTuning.ts` reads
  w4922's per-test history: each test the master batch caught for real on a PR whose gate never ran it is filed, one
  request a day (auto-approved, source `master-batch`, kind `gate-miss`), for a worker to pull it into the gate with the
  game repo's `scripts/gate_tuning.py` (game PR #4073). The always-run checks with at least 300 gate runs over 14 days,
  no failure there and no catch anywhere are proposed for moving out, never moved, with determinism and save guards
  flagged. `test_history {query: "gate_tuning"}` reads the day's summary. Needs a portal deploy.
