- **`ff-pr merge` merges a PR that no workflow runs on because every changed file is under the base's path filters**
  (w5017): ffu's ci.yml has `pull_request: paths-ignore: ['docs/**']`, so a docs-only PR got no run and `ff-pr merge`
  waited on CI that never came (ffu #395, #754, #938 were each merged by hand). When the head has no workflow run at all,
  ff-pr reads every `.github/workflows/*.yml` at the PR's base (machine/ciPaths.ts) and merges with
  `--match-head-commit` only when at least one pull_request trigger's `paths`/`paths-ignore` leaves out every changed
  file and no workflow would run, saying why (`CI: none will run: ...`); `ff-pr status` answers 0 and `ff-pr push` prints
  `next: ff-pr merge` instead of the blocked_on line. It fails closed: a run that exists (red or running), a trigger with
  no path filter or a branches/types filter, a pattern it does not read (`!`, `[]`, `+`, `{}`), an unreadable workflow,
  no workflows, or over 300 changed files all keep the old wait. A rename lists both paths.
