- **The master batch watch reads the new `hung` and `unresolved` verdicts** (w5415; docs/intake.md, "Master batch reds").
  FinalFactory PR #4299 (w5413) stopped the batch blaming a merge when no run confirmed a failure. The portal logged those
  runs as "no verdict line" and filed nothing. Now an `unresolved` batch (a real failure the confirm run gave no result for)
  files the not-bisected request's variant, which says to reproduce first and never revert blind. A `hung` batch (its only
  failure a hung editor) files at most one open infrastructure note at normal priority, never a revert, and a later green
  run supersedes it. Each run's `ran`, `hung` and `infra` fields are read and listed in the brief. Neither verdict names a
  culprit, so neither holds a version bump. Tests: `masterBatch.test.ts`. Needs a portal deploy.
