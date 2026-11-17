- **The leftover sweep no longer ends a live timed run's bench-queue helper** (w4588). On lothdesktop, 2026-11-17, timed run
  tr_6b6935944b (w4554's 16 against 20 UPS legs) waited for exclusive ticket t00007358 through a `bench_queue.py hold` child of
  the daemon. That child carried the asking worker's FF_SESSION_ID, so when w4554 moved to biscuit (a w2046 room move) the sweep
  ended it (and its conhost) as worker 974429a3's leftover, "no request waits for it", and the run failed with "the bench queue
  helper exited 1". The run's helper and its legs' players now also carry `FF_TIMED_RUN=<run id>`
  (`machine/timedRunner.ts` timedRunEnv), and the sweep spares any process with a run that is still live in the daemon (queued
  or current), whatever became of the worker that asked for it. Once the run is over they are judged by their session as before.
  Also: a stopped worker whose open request moved to another worker now counts as still waited for. Its leftovers get the 10 min
  grace, not 2, and the sweep's message names the moved request (`server/resumable.ts` movedRequestsOf, from the portal's
  `owners`). Tests: `w4588TimedHelperSweep.test.ts`. A real child process stands in for the helper; the worker stops or its
  request moves while the run waits; the helper survives 13 looks of the sweep and then gets its ticket. Before the fix it was
  ended at minute 3.
