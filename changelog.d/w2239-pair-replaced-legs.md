- **A pair run closes on its newest attempt's DONEs** (w2239, lothsahn: "once the attempt that produced a pair run's
  verdict has finished, the request closes, even if worker legs from earlier failed or replaced attempts never said
  DONE"). A leg of an earlier attempt (not among `pair.started`'s legs, started before them, not done) counts as ended once
  the newest attempt's host leg said DONE: `stillOn`, `workerEnded` and `recheckDone` (server/orchestrators.ts) and the
  ledger cleanup's after-merge and w1870 checks (server/ledgerSweep.ts) skip it, through `replacedLeg` (server/work.ts).
  w2175 (1168453d stopped waiting for a host LISTENING) and w2224 (the earlier host leg 1a047a74) had to be closed by hand.
  Test: orchestrators.test.ts "w2239".
