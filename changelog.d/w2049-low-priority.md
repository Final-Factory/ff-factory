- **Priority low, and started pinned work first** (w2049, lothsahn: "Please introduce a new priority "low" that is below
  normal/medium priority"; "Work that has started and requires a specific machine should be prioritized by the dispatcher
  over general work when that machine frees up slots"). Low already sorted last in every queue (the capacity ping, the
  ledger, released workers' resumes, the bench queue); it now shows on the Requests page beside high and urgent, and a
  request's detail there has a Priority control (its people, an intake reviewer or an owner; `POST /api/work/<id>/priority`).
  Low never ages up: it waits behind normal work and starts whenever nothing above it fits, so no slot sits idle. The
  capacity ping orders the queue by priority, then started work that runs only on the computers it names (a leg its worker
  waits on, a handed-off timed leg, a requeued request that names its computers), then the oldest (`capacityOrder`,
  `server/work.ts`); the dispatcher's prompt says higher work that fits another computer starts there. Docs:
  orchestrators.md ("The order queued work takes room in"). Tests: `orchestrators.test.ts`, `work.test.ts`,
  `benchState.test.ts`.
