- **One free sandbox is room for one queued request, and a sandbox being handed over is not free** (w1944, lothsahn: "Why
  does the dispatcher say biscuit has room when it's full?"). Each computer's room is counted in workers (`RoomNow.slots`) and
  handed out in queue order (urgent first, then the oldest): the requests behind the first that fits read "biscuit has room,
  but it goes first to w1917, ahead in the queue" instead of WRONG, and `decide_work queue` takes them. A sandbox whose
  editor is stopped and branch switched for a new worker (before that worker exists) no longer counts FREE, and a second
  start there is refused. Docs: orchestrators.md ("Queued"), machines.md ("Placing work"). Tests: `w1944RoomShares.test.ts`,
  `orchestrators.test.ts`, `machineSandboxes.test.ts`.
