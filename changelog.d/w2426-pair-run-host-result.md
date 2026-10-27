- **A request Blocked on a pair run's report waits for the host leg's result** (w2426, asked by lothsahn: w2419's worker
  was resumed twice on 2026-10-27, at 21:00 and 21:01 UTC, by w2425's client leg saying it was still waiting for the host,
  while the host leg was still building). A pair run now delivers only through the host leg's (leg 1) report with both
  "For <waiter>:" and "DONE", a host still-open line that waits on the waiter, or every leg's DONE (server/ledgerRules.ts
  `pairDelivers`). Every other `on: report` wait is tightened the same way: only `DONE`, a "For <waiter>:" line or a
  still-open line that waits on the waiter delivers; a turn end with no status line, or one that merely names the
  request, no longer does. A pair run's legs are told the rule when the wait is set, and a wait the ledger records from a
  worker's report (w2422) tells the other request's workers to mark their result too (docs/orchestrators.md).
