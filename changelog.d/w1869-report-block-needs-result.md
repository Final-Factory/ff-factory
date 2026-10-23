- **A request blocked on another's report waits for the result, not for progress** (w1869; lothsahn: "Analyze your recent
  tool failures and make it so they don't happen in the future"). w1820 was blocked on "w1785 reporting (dec9a619's
  LothDesktop timing of A vs A + PR #2268)" and unblocked by "w1785: still open: the LothDesktop A/B is running…", so its
  worker resumed with no timing. A `request` gate with `on: report` now clears on that request's DONE, on a report line
  `For <waiting request>: …`, or on a report with no still-open or paused line for it (`ledgerRules.reportDelivers`); a
  progress report leaves it Blocked. When such a gate is set, the workers on the awaited request are told what it waits for
  and to mark the report that carries it (`Orchestrators.tellReportWaited`). docs/orchestrators.md, "Waiting, Queued,
  Blocked". Tests: `ledgerRules.test.ts`, `blockers.test.ts`, `orchestrators.test.ts` (w643, w1869).
