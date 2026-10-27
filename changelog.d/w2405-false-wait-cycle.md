- **A timed leg's "For wNNN:" report line is no wait on its parent** (w2405, ben). The ledger read w2401's "waiting for
  lothdesktop's exclusive bench ticket, then the "For w2396:" report" as a wait on w2396, so the blocker watch saw a wait
  cycle (w2396 -> w2401 -> w2396) and resumed w2396's worker for nothing, twice in five minutes (2026-10-27). A wait now
  ignores the request a report is addressed to and anything after "then", and a parent's gate that says the leg "needs
  nothing from" it rules out a wait back read from the leg's words; a real block back is still a cycle. Tests:
  `orchestrators.test.ts`, `blockers.test.ts`, `workState.test.ts` (w2405).
