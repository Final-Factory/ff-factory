- **A retry of a pair run starts fresh legs** (w2041, Ben: "stop the loop seen on w1976"). w1976, the pair run for w1904's
  PR #2364, had its client leg on lothlaptop, whose Tailscale was stuck, then offline; w1904's worker asked "retry" and
  "retry 2", and each ask joined w1976 again and was resumed at once by the old host leg's next DONE. Now `request_pair` on
  an open pair run that is spent (a leg already said DONE, a leg's computer is offline or its worker errored, or the worker
  passes `retry: true`) cancels it and files a fresh one, with no legs, that keeps off the computers its legs failed on
  (`pair.avoid`, plus the worker's own `avoid`). The asker waits on the fresh run's report only. A worker whose part of a
  request is done is told who is still on it once per change, not on every DONE (the old loop sent w1976's host leg
  f09cb847 the same notice about 8 times at 12:50Z). Docs: machines.md ("A retry starts fresh legs"), orchestrators.md.
  Tests: `orchestrators.test.ts` and `ledgerSweep.test.ts` (w2041).
