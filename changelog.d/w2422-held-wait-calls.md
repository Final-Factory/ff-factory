- **A worker's blocked_on is no longer lost while the portal is unreachable** (w2422, asked by lothsahn: w2335's
  blocked_on, made during the 2026-10-27 10:05-10:20 UTC portal restart, was refused with "the portal is unreachable
  right now", and w2335 sat Stalled for 9 hours after w2338 closed). The daemon holds the calls that set what a request
  waits on (`blocked_on`, `waiting_on_person`, `wake_me`, `cancel_wake`, machine/portalCalls.ts) and sends them in order
  once the link is back, again with the same id after a link that dropped before the answer (the portal applies an id
  once, server/answeredCalls.ts); after 15 min they fail with "<tool> was NOT recorded … Do not end your turn as if it
  had worked". Every other tool on a down link says it was NOT done. The safety net: an open request with no gate whose
  stopped worker's report says "still open: blocked on wNNN" gets that wait as its gate (server/blockerWatch.ts
  recordReportedWaits), so it shows Blocked, not Stalled, and its worker is resumed when wNNN closes or reports
  (docs/portal-logs.md).
