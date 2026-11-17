- Merge on green tries again a minute later when GitHub fails the merge with a passing error (a 502, "GraphQL: Something
  went wrong", a timeout), up to 4 tries, instead of resuming the worker to merge by hand (w4531, for lothsahn's wall-time
  analysis: four ffu merges on 2026-11-16 resumed their workers so).
