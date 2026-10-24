- **Spend: a resumed conversation no longer bills its whole running total as one turn** (w2007). When the CLI resumed from totals it had
  saved a few turns back, the portal read the slightly lower totals as a count that began again and billed the session's whole running
  total to the request the turn named: w1737 read $425 of Ben's orchestrator for four turns, w1349 to w1351 about $96 each of the
  dispatcher, w863 and w788 $67 each. Such a turn is now billed its own main-loop usage; the turns already recorded are corrected once,
  150 seconds after the portal starts (`spend repair (w2007)` in the journal), from the transcript read in pieces (docs/spend.md,
  "A resume that carried older totals").
