- **A request is started once** (w2548; lothsahn: "Guard start_agent so that a request with a running worker in a sandbox is
  refused, and a second worker in an occupied sandbox is refused"). On 2026-10-29 at 15:19Z the timing order (w2055)
  started the timed leg w2547 in lothdesktop/slot1, and a minute later the dispatcher, whose `[work request]` said "Decide:
  start it", started it there again: the first worker's status was still "stopped" (its brief waited on the save's
  download), so start_agent's live check skipped it, and the sandbox check skipped it as the request's own. Now
  `start_agent` refuses a request being started (by the timing order or another start_agent) or with a worker, one just
  started included, naming it; the request's own worker occupies its sandbox like any other; each start holds the request
  through its sandbox hand-over and checks again in the same run as the start; and a timed leg's `[work request]` says FF
  Factory starts it itself. Docs: orchestrators.md. Tests: `orchestrators.test.ts` (w2548).
