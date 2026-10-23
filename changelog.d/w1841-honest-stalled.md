- **Stalled is only what nothing will move** (w1841; Ben: "why are these stalled?", on six requests that were not). The
  ledger's live state (`shared/workState.ts`) now reads, before it says Stalled: a worker an urgent release's build paused
  is Blocked on that build (`BuildPlans.pausedFor`; its `done` also tells a worker placed on another computer since); a
  report waiting on a held bench lock is Blocked on the lock, and the blocker watch tells the worker when it is free
  (`Agents.resumeBenchWaits`); a wait on the bug's reporter or a player is Waiting on input on them (`outside`, never a
  [needs you]); a wait on a person counts whichever worker of the request said it, and a note another worker took up no
  longer settles it; a wait on another request's worker is Blocked on that request, and `blocked_on` takes `reports` (a
  request gate that clears at that worker's next report); a worker waiting on the orchestrator for its own pair check,
  build or CI is told at its turn's end that it is its own work, and every worker's prompt says so. A build's clearing no
  longer pauses dead workers that hold nothing (1.0.0.10 listed 7819). Docs: orchestrators.md, "Waiting, Queued, Blocked".
  Tests: `workState.test.ts`, `buildPlans.test.ts`, `orchestrators.test.ts` (w1841).
