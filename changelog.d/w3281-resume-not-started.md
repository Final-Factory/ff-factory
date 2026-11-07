- **A worker holding a request it has not started is resumed on it** (w3281, lothsahn: "FF Factory must not let it go idle
  and lose that request"). w3236 was sent to ac029c0c while it was on w3233; its turn ended "w3236: still open: not
  started", the merge-on-green pilot merged w3233's PR and filed its report with no model turn, nothing resumed it, the idle
  stop released its sandbox, and w3236 sat Stalled. Now each turn end (the merge-on-green filing included) resumes a worker
  that holds an Active request whose still-open line says "not started", unless it comes back by itself (mid-turn, a
  check-in, a queued message); still not started after that within 6 hours, the dispatcher is told to place it. Docs:
  orchestrators.md. Tests: `ledgerSweep.test.ts` (w3281).
