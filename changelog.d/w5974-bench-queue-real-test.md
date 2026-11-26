- **The w1615 test against the real bench_queue.py passes inside a worker, and a failure no longer hangs the run** (w5974):
  run with `FF_GAME_REPO` set by a worker, its tickets carried the worker's `FF_SESSION_ID`, and since the game repo's w2605
  rule (a session's shared ticket rides its own running exclusive turn) the build's shared ticket was granted at once instead
  of waiting. The test now takes its tickets with no session, and releases every ticket it took in an after-hook, so a failed
  assertion ends its helpers and the test runner exits. CI skips this test (no `FF_GAME_REPO`); test-only, no deploy needed.
