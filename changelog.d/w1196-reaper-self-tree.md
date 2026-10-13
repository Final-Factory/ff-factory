- **The leftover-process reaper ends leftovers on Linux and Mac machines too** (w1196 follow-up). Deployed at a9d5eae, it
  spared the daemon's parent with its whole process tree; under systemd that parent is `systemd --user`, under launchd pid 1,
  the very process every detached player and orphan is reparented to, so on biscuit it ended nothing (measured: a stopped
  worker's player and Xvfb still ran 10 min after the update). The daemon and its parents are now spared alone, never their
  trees; the tests' fake machine runs the daemon under the same systemd as its orphans.
