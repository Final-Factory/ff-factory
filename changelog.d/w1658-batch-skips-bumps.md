- **A master batch skipped at a version bump is not a green batch** (w1658, lothsahn: "bumps stop waiting on the train,
  and the train skips release commits"). The game repo's `master-batch.yml` now skips its batch job on a bump's push (the
  bump's own run tests the whole suite), and that run still ends in success. The master batch watch reads no log for it,
  files nothing, and never takes it as the later green run that supersedes a red one, so a culprit is still filed when a
  bump lands right after a red batch. Docs: intake.md ("Master batch reds"). Tests: `masterBatch.test.ts`. Needs a portal
  deploy.
