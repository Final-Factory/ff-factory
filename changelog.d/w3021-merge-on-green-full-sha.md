- **Merge on green passes GitHub the full head sha** (w3021, ben). A worker's `head` given short (`3e14de3aa516`) reached
  `gh pr merge --match-head-commit` as is, and GitHub refused it ("Could not coerce value to GitObjectID", ffu#200), so the
  merge failed and the report left with merge_on_green was never filed. blocked_on now records the pull request's own head
  whole when the worker's head is a prefix of it, and the merge resolves any head still short from the PR's `headRefOid`;
  a pull request whose head does not start with it is not merged. The other GitHub calls that take a sha (ff-pr merge, the
  CI reads, the automatic deploy's run reads) already pass full shas read from GitHub. Docs: orchestrators.md, "Merge on
  green, a pilot". Tests: `mergeOnGreen.test.ts`, `orchestrators.test.ts` (w3021).
