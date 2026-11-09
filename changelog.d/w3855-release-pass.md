- **The minute's release pass costs less** (w3855, for ben: the first pass after the f000870 restart on 2026-11-09 held the
  event loop 1.2 s). It no longer reads the waits of released workers that take no step anyway (`placeAgain.ts`
  `staysReleased`), looks only at a sandbox's own sessions for who else works there (`groupedBySandbox`), reads each
  worker's requests from the pass's index (`agents.ts` agentOnly), and parses each link time once (`blockers.ts`). What it
  decides is the same; on restart-lag-bench its CPU time fell 42%.
