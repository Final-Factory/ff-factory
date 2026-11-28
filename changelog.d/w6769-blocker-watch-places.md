- **The blocker watch reads places once for its last steps** (w6769, lothsahn: "no event-loop block over 1 s on the live
  portal"). The exclusion audit, the pair cut, the room and the queued-with-room flag each computed `places()` and every
  machine's claims afresh (five times per look): 100 blocks of 1-5 s, 169 s of the 653 s blocked from 05Z to 12Z on
  2026-11-28. They now run in one placement pass (`Agents.placementRead`), worked out again after a step saves or drops a
  request. The same requests are flagged, cut and logged. On the synthetic bench (`scripts/bench-loop-blocks.ts --tickRounds 3`,
  new) one look went from 1.10-1.16 s to 0.21-0.26 s. Tests: `loopBlocks.test.ts`.
