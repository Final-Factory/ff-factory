- **LothDesktop's ffu CI runners run their jobs at Normal priority, however they last started** (w6163): a runner started
  through its scheduled task ran at task priority 7 (BelowNormal), and its jobs inherited it (both workers logged at
  BelowNormal on 2026-11-26 17:46Z, w6110). At logon the runner starts from the Startup folder at Normal instead.
  `machine/runnerPriority.ts` sets each runner's task to priority 5 (Normal) through the Task Scheduler, and raises a
  listener below Normal to Normal, so the jobs it starts after that run at Normal. Nothing is restarted. It enforces only
  on lothdesktop. Every other Windows machine, BEAST included, only logs `runner priority:` lines. daemon.json
  `runnerPriority` (`off`, `warn`, `enforce`) overrides it at the daemon's start. New installs get the same priority from ffu #1204.
  Needs a daemon update.
