- **A request whose worker waits in a machine's queue shows Blocked on it** (w1949; lothsahn: "Show those requests as
  blocked, with the existing blocked state in the request list, and clearly indicate that they're blocked on the exclusive
  lock"). A worker waiting for a bench ticket, mid-turn or between turns, now reads "Blocked on the exclusive bench lock on
  lothdesktop (held by w1908 / t00000911 since 22:35 UTC, 1 ahead in queue)" in list_work and on the Requests page (a wait
  behind shared holders says it is a shared lock), and Working again once its ticket is granted. A `unity-slot run` waiting
  for a Unity slot, and a queued sandbox editor start while its worker waits with a check-in, show Blocked with their own
  reasons. Read from each daemon's report of its queues (the bench queue's waiters, the waiting slot runs' sessions), never
  from the worker's words. Docs: orchestrators.md ("Ledger"). Tests: `w1949QueueWaits.test.ts`, `unitySlots.test.ts`.
