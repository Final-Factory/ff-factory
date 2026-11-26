- **A disk clean-up worker can get an idle FFU runner's job folder removed now, or is told up front that it stays** (w5929,
  lothsahn; found in w5911 on LothDesktop, `_work\ffu` 15.1 GB). On Windows a fenced worker cannot delete it (the runners'
  Medium integrity label, w5499), and the daemon's hourly pass keeps it 14 days on a disk that is not low. A worker on a
  disk clean-up request (`disk_cleanup`) of its own machine now has `machine_cleanup` (`Agents.workerCleanup`): it asks
  that machine's daemon for the same asked pass the dispatcher's `machine_cleanup` runs, which counts as low
  (server/cleanup.ts `run`), so the rule ffu-runner-work takes the folder once it is untouched 15 min, still only while
  that runner runs no job and, on a worker install, only inside the install folder. It runs in the background (one at a
  time per machine) and its result comes to the worker as a `[clean-up]` message; any other worker is refused. No daemon
  code or rule changes (the daemon gets the tool from launch.ts's catalog; an older daemon leaves it out). `ff-leftovers
  folders` (on Windows) and `ff-leftovers remove`'s EPERM refusal say how the folder goes (`runnerWorkRoute`,
  server/installLeftovers.ts), the worker's `read_rules cleanup` says when to run it, and the dispatcher's low-disk rule
  says never to brief a worker to "trigger" the rule. Tests: `orchestratorsAsks.test.ts`, `w3502TimingRunnerCleanup.test.ts`,
  `w5235RunnerPlayerCache.test.ts`, `toolManifest.test.ts` (w5929).
