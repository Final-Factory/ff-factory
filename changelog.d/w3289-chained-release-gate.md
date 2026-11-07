- **A request blocked on another's report is unblocked by its milestone, not its close** (w3289, lothsahn: "Please fix
  that so that when we chain releases in the future you don't wait like this"). w3246 (the pre-1.0 release) was blocked on
  "w3245 reporting (the 1.0 release live with its notes posted)" in the minute w3245's worker started, so that worker was
  never told to mark its result `For w3246:`; its live-with-notes report kept w3245 open for a 24-hour after-check and w3246
  waited until a person unblocked it. The blocker watch now tells, once per gate (`WorkBlocker.told`), every worker on the
  awaited request that was not told yet, a worker asleep on its own check-in included (the message resumes it and keeps
  the check-in), and the message says the line need not wait for its DONE or an after-check. The dispatcher's prompt says
  a wait for another request's milestone ("once the 1.0 release is out") is `on: report` naming the milestone. Docs:
  orchestrators.md ("Blocked on <what>"). Tests: `orchestrators.test.ts` (w3289 replay).
