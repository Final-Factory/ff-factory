- **ffu's post-merge reverts go back to the reverted PR's request** (w4930; docs/intake.md, "ffu post-merge reverts"). ffu's
  `ci.yml` now runs the macOS checks and crosscompare after a merge and its `culprit` job reverts the merge that broke them
  (ffu PR #921, w4923). `server/ffuPostMerge.ts` reads that job's `POSTMERGE_VERDICT` line every 3 minutes: on `reverted` the
  request whose PR was reverted (it lists the PR, or the PR's `Request:` line names it) is reopened if done, or told if open,
  with a note to land the fix again; on `not reverted`, `no culprit`, no verdict line, or a revert no request can take,
  Lothsahn's and Ben's orchestrators hear that a person must look. Each run is handled once. Needs a portal deploy.
