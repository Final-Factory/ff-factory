- **The agent tools checkout repair clones first** (w5776, after w5787's review): the new clone of FF Factory's
  `<root>/tools-medium/final-factory-agents` is made beside it and swapped in only once it worked, so a repair during a
  network outage keeps the old, readable checkout instead of leaving none.
