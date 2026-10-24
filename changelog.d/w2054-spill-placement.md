- **Placement spills down the list past computers at 50% load or more** (w2054, lothsahn): new work goes to the first
  computer in `placement.prefer` under `placement.spillAtPercent` load (default 50), then to the overflow under it, and
  only when everything is at or over it to the old strict order up to real capacity. Load is the larger of the CPU use
  over the last minute and the agents mid-turn over the cap. `placement.spillAtPercent 100` turns it off. Each start logs
  `placement: ...` with every online computer's load. Needs a portal deploy (docs/machines.md, "The spill below 50% load").
