- **The ledger cleanup no longer closes a merged request that is blocked, waits on a person, or was just moved** (w2493,
  lothsahn: "the cleanup never closes a request that is blocked (on a time, another request, a machine or a person)").
  A w1600 move (`stop_agent move_to`) takes a request off its worker (`Orchestrators.moveOff`), and the cleanup read
  reports only from the request's current workers, so with none its "still open" report went unread and the merged-PR
  and deploy closes fired: w2443 (pausing a machine stops its runs) and w2014 (read-chain pilot) closed at 00:00Z on
  2026-10-29, three minutes after their move, while the dispatcher had them blocked on w2482 and on a time. Now the
  workers it was moved off speak for it until it has a new one, and `heldOpenReason` (`server/ledgerRules.ts`) holds
  open any request blocked by the dispatcher or a worker since its last DONE, or whose worker waits on a person for it,
  in the merged-PR close, the deploy close and its resume, the delivered close and the refused-DONE re-check. The
  cleanup's own deploy block still closes on the deploy. Docs: orchestrators.md ("Ledger cleanup"). Tests:
  `ledgerSweep.test.ts` (w2493).
