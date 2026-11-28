- **A daemon frozen 3 minutes is ended so its supervisor starts a fresh one** (w6555, stage 2 of the freeze watch). When a
  freeze reaches `freezeWatch.exitMin` (daemon.json, default 3) the watch logs it with the main thread's stack, checks the
  loop is still frozen, and ends the process with SIGKILL (TerminateProcess on Windows). `run-daemon.ps1`, the LaunchAgent's
  KeepAlive and the systemd unit's `Restart=always` start a fresh daemon about 10 s later, and agents run on, since their
  hosts are detached. On BEAST's 891 s freeze (w6546) this would have had the machine back after about 3 minutes rather than 15.
  `exitMin: false` or `FF_FREEZE_WATCH=log` only logs. Docs: machines.md. Tests: `freezeWatch.test.ts`.
