- **The master batch watch reads pre-1.0's batch too** (w6457, lothsahn). The game repo's `master-batch.yml` runs after every
  merge into `pre-1.0` since w6444 (FinalFactory PR #4425); the watch now reads each branch in `masterBatch.branches`
  (default master and pre-1.0) on its own, and a red pre-1.0 batch files `pre-1.0 batch red: ...` with its revert from
  `origin/pre-1.0` and its PR into pre-1.0. Master's requests read as before.
