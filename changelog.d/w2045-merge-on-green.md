- **Merge on green, a pilot** (w2045, lothsahn: "Have FF Factory merge green PRs itself with no model; the worker reports
  before the wait"). In a share of requests (`worker.mergeOnGreenPilotPercent`, default 0, off; by a hash of the request id),
  a worker waiting on its PR's CI with `blocked_on` may leave the report it would write after the merge (`merge_on_green`).
  When every check passes, FF Factory merges the PR at that head on the person's GitHub token and files the report, which
  closes the request with no model turn (the median green-CI turn cost $0.39, measured over 275 turns on beast). Red CI or
  a refused merge resumes the worker as before. The CI-cleared note now says `ff-pr merge`, not the refused `gh pr checks`.
  Docs: orchestrators.md ("Merge on green, a pilot"), spend.md. Tests: `mergeOnGreen.test.ts`, orchestrators.test.ts "w2045".
