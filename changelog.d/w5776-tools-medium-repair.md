- **A broken agent tools checkout repairs itself** (w5776, after w5763's review of w5597): when the same fault in FF
  Factory's `<root>/tools-medium/final-factory-agents` (dirty, wrong branch or origin, diverged, a failed fetch) shows up
  on 3 publishes in a row, or at once when the folder has files but no `.git`, the publish moves it to
  `final-factory-agents.broken` (one backup, the newest) and clones it again. No person is needed at the machine.
