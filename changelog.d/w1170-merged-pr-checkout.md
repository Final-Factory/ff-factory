- **A pull request merged before its FFBox jobs start no longer fails every job at checkout** (w1170): GitHub deletes the test
  merge once a pull request is merged, so the host could not mirror it. ci-actions `fa72019` tests the pull request's head
  commit instead, with a warning; the pins here move to it.
