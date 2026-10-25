- **Every worker compacts earlier** (w2002, lothsahn: "File the compaction pilot plus the base-context trim and noise fixes"). After a
  day with half the workers in the pilot (beast, 20 control and 25 pilot Opus sessions, measured), the pilot cost 17% less at list
  price for a session of the same length (24% less over 140 calls), with no more re-reads or repeated commands after a compaction.
  `worker.earlyCompactPilotPercent` now defaults to 100: every worker compacts between turns from 120,000 tokens and within a turn
  from 150,000. Set it under 100 for a control arm again. Docs: spend.md ("Compacting earlier, a pilot", its result).
