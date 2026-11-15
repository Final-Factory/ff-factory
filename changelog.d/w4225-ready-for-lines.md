- **A worker's "ready for" lines no longer leave a request Stalled** (w4225, lothsahn). w4207's worker ended its turn with
  "w4207: ready for the pair run", "w4207: ready for stills, needs a non-m3 computer" and a still-open line naming the pair
  run with no wait word; nothing read them and the request sat Stalled 2 h. Now a still-open or "ready for" line that names a
  pair run with none filed tells the worker to call request_pair (w2057's nudge, widened), and a second stop without one tells
  the dispatcher to file it; a "ready for <leg>, needs a non-<computer> computer" line queues that leg on the other game
  computers, so the request reads Queued. Docs: orchestrators.md, machines.md. Tests: `orchestrators.test.ts`,
  `pairRuns.test.ts`, `ledgerRules.test.ts`.
