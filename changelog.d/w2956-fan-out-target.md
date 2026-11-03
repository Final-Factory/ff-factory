- **The dispatcher starts the legs a worker hands it, and keeps a fan-out request at its target** (w2956, Ben: "keep 8 to
  10 rows running at once, and start the next row as soon as one merges"). A worker's "wNNN: still open: the dispatcher
  starts the ten rows above" now reaches the dispatcher as a `[work update]` with the report, once; before, it went only to
  the requester's orchestrator, and w2895's ten rows sat unstarted from 05:14 to 11:57 UTC on 2026-11-03. A request whose
  people's note or brief says "keep N running" is checked after a worker ends a turn, stops or merges, or a daemon
  connects, and the dispatcher is told to start legs up to N while fewer run (at most every 30 minutes, again within 4 hours
  only when it lost a leg). Docs: orchestrators.md ("Where messages go", and the w2956 item under "Waiting, Queued,
  Blocked"). Tests: `w2956FanOut.test.ts`, "w2956: the w2895 stall" in `orchestrators.test.ts`.
