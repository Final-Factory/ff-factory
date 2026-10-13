- **ci-actions is pinned at `@v1`, and a pull request merged before its FFBox jobs start no longer fails them at checkout**
  (w1170): a compatible ci-actions change now reaches every job when its `v1` tag moves, with no edit here. GitHub deletes the
  test merge once a pull request is merged, so the host could not mirror it; `checkout` (ci-actions `fa72019`, the first `v1`)
  tests the pull request's head commit instead, with a warning.
