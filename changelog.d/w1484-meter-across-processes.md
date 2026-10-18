- The spend meter keeps its tally of a conversation across processes (w1484): an agent saves it after every model call
  (`<appDir>/meters/<session id>.json` on a machine, `<data>/meters/` on the portal), and a resumed process picks it up, so a
  resumed worker's history stays in its categories (file reads, shell, the agent's own output, …) instead of one lump of
  `carried`, and its base is measured again by its first call (by the cache, or by counting). Only conversations from before
  the deploy, or moved to another machine, are still carried.
