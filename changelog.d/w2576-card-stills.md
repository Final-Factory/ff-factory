- **A worker's stills in a waiting card's Details and in the main chat show as pictures** (w2576, Ben: "a lot of previews in
  the waiting on input are not showing their preview images"). The Details text read every still without the waiting
  worker's session, so any still outside the review folder was refused (400 "give session or machine") and showed only its
  alt text, as on the w2198 card ("Beacon Spire next to a portal"). It now reads them as that worker. The orchestrator's
  chat now reads a worker's still in its own temp folder (`ffa-<id>`) on a machine as that worker: before, the daemon
  refused it. Pages also report each still they could not show, and the server logs its own refusals, as `[media]` and
  `[image]` journal lines (docs/portal-logs.md). Tests: `e2e/waitingCards.spec.ts` (w2576), `server/mediaTrouble.test.ts`.
