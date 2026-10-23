- **A release build hands its sandbox back on its own branch** (w1856; Ben's request after the 1.0.0.12 urgent release
  left beast/slot1 on `urgent/1.0.0.12` and the next worker there committed on it). switch_branch onto `urgent/<v>` or
  `release/<v>` remembers the branch the sandbox left, and `build_plan done` puts it back there (or on a fresh branch)
  before the workers paused for the build carry on. New work never starts on a release branch: the sandbox is switched
  to a fresh branch first, and a handover that still lands on one warns. The shell guard refuses a commit, merge,
  cherry-pick, revert, am, pull or rebase in a sandbox on `urgent/*`. docs/orchestrators.md, "The hand-back".
