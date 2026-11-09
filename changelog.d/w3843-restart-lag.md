- **The portal no longer blocks for 10-17 s after a restart** (w3843, for ben: after the 67a7d58d deploy on 2026-11-09 five
  of six machines dropped for 3-4 minutes). The queue drain now reads placements once per drain, not once per queued item
  (`sessions.placementPass`; actions that move workers read fresh), and a drain asked for inside a drain runs as the next
  round instead of nesting, with the queue file written once per drain. The release pass reads the ledger's live state once
  per pass (a pass longer than 5 s re-read it for every later worker), looks up a sandbox's occupants in one index per claims
  read, memoizes "agent-only" per pass, and `workLiveAll` reads each worker's own requests instead of the whole ledger.
  Placements are unchanged (`scripts/restartLagScene.test.ts` runs a drain, a release pass and a second drain with and
  without the memos and compares every decision). A machine that was connected when the portal stopped now counts offline
  from the restart, not from its last report before it (biscuit showed "offline 61 min" a minute after the restart). The
  stall profile names a regular expression "RegExp", not by its source. Bench: `node scripts/restart-lag-bench.ts`.
