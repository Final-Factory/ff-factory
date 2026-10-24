- **A timed leg goes to a small computer: the worker asks before an exclusive bench ticket** (w1969, lothsahn: "Why are these on
  the big machines and not scheduled for m3 or even biscuit? The scheduler should favor running exclusive locks on machines with
  a small number of slots", then "Maybe every time a worker needs an exclusive lock it should ask the dispatcher?"). A worker's
  new `timed_place` tool answers "here" (a small computer, a same-machine reason, the release lane, no small computer online)
  or hands the leg to the small computers that take timed runs (LothLaptop, m3, biscuit; never m5): FF Factory files it as its
  own request, Queued for them, whose worker times both sides there and reports, and the asking request is Blocked on that
  report. A busy small computer queues the leg; after 60 minutes any computer that takes timed runs may take it. On a big
  computer the guard refuses the ticket-taking commands until the worker asked, and each answer is a line in the request's log
  and the portal's journal (`server/timedAsk.ts`, `Orchestrators.fileTimedLeg`/`timedLegBound`; docs/machines.md "Where a
  timed leg runs").
