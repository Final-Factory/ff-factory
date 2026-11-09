- **The minute's release pass costs less** (w3855, for ben: the first pass after the f000870 restart on 2026-11-09 held the
  event loop 1.2 s). It no longer reads the waits of released workers that take no step anyway (`placeAgain.ts`
  `staysReleased`), looks only at a sandbox's own sessions for who else works there (`groupedBySandbox`), reads each
  worker's requests from the pass's index (`agents.ts` agentOnly), and parses each link time once (`blockers.ts`). What it
  decides is the same; on restart-lag-bench its CPU time fell 42%.
- **A session's cost increase no longer rewrites spend.json on the main thread** (w3855: 1.2 s and 1.1 s portal blocks on
  2026-11-09, `recordCost` under `writeJsonDurable`). Since w859 the usage meter's 7-day fallback kept its day totals in
  `spend.json`, SpendStore's file, so every increase wrote SpendStore's whole startup copy back over it. The totals now live
  in their own `spend-days.json`, saved in the background and flushed when the portal stops; the fallback's week starts
  afresh once.
