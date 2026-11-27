- **Git starts, a runner PowerShell's kill and the progress write no longer hold the daemon's loop** (w6554, after an hour
  of BEAST's daemon log on 2026-11-27). `gitExecFile` and `gitFence` (the clean-up's `unpushedWorkWhy`, liveIdle,
  selfUpdate, the leftover scans, and every `run('git')`) start both their programs from the spawn thread, where one git
  start held BEAST's loop 19-49 s. RunnerEnv's PowerShell, the load gate's runner start and the runner units' `systemctl`
  also start from the spawn thread, so a run that passes its timeout is ended there too (the 24.5 s `kill` under
  RunnerEnv's step). An agent host's `daemon.progress` is saved with an async write, one at a time; a failed one is tried
  again at the next progress (6.6 s on BEAST). The answers are the same. Tests: `gitOffLoop.test.ts`, `hostWatch.test.ts`.
