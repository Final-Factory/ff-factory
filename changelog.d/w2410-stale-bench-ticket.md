- **A stopped worker's queued bench ticket no longer blocks the queue or its requests' live state** (w2410, lothsahn: a
  queued bench ticket must not outlive its worker's wait). On BEAST, 2026-10-27, worker d2d9c644's shared ticket t00002471
  (`unity-slot run`, "unity: w2367 release base for launch clip") waited for hours after its worker stopped blocked on w2402,
  holding a Unity slot, and w2366, w2367 and w2370 showed "Blocked on the shared bench lock on beast" all that time.
  - The leftovers reaper no longer spares a worker's own `unity-slot` command because its command line names the daemon's
    folder: it and its ticket's helper end with the worker's other leftovers (machine/leftovers.ts).
  - A worker stopped with its sandbox released is marked away in its machine's bench priorities, so bench_queue.py parks its
    waiting tickets (w1984) and queues them again at the back once it is placed again (server/agents.ts benchAway).
  - The daemon's bench state reports a parked ticket last, as `parked`, never as the next exclusive turn, and no request
    shows Blocked on it; a stopped worker with nothing to bring it back, or with its sandbox released, no longer holds its
    request on its own queue wait, so the request shows its real block ("w2402 reporting"). A worker that keeps its
    sandbox between turns (a check-in, a run going) still shows its wait.
  - A shared ticket with no exclusive ticket ahead of it no longer reads "an exclusive ticket waits for all of them to finish".
  Tests: `w2410StaleTicket.test.ts`, `leftovers.test.ts`, `orchestrators.test.ts` (w2410).
