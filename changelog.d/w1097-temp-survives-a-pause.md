- **A stopped worker keeps its temp folder while its request still waits for it** (w1097). The w913 sweep emptied a
  worker's folder 10 minutes after its process ended, so a wait for CI or a person, a stop or a pause (LothDesktop's V:
  grow, 2026-10-12) cost a worker its files: dcf976fc (w1086) lost its "before" clips and a player build in progress. The
  portal now tells each daemon which sessions a request still waits for (`welcome` and a `resumable` message, no protocol
  bump); the daemon's sweep and daily clean-up leave those folders, and a folder goes 10 minutes after no request waits
  for it any more. The worker brief says so. Needs a portal deploy and the machine daemon update that follows it. Docs:
  self-recovery.md (w1097, "But it also ran on a pause"). Tests: `resumable.test.ts`, `machines.test.ts`,
  `machineProtocol.test.ts`, `evidenceRules.test.ts`.
