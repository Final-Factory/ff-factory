- **A Windows daemon stuck mid-exit is now recovered, and a restart over ssh no longer needs the Task Scheduler** (w6784,
  stage 2; lothsahn asked for "self-healing wherever it's safe" after BEAST stayed offline from 2026-11-28 07:41Z). When a
  daemon said it ends and is still there 2 minutes later, `run-daemon.ps1` ends it again itself and, if it is still there,
  leaves it behind and starts a fresh daemon (a `supervisor-warn-only` file in the daemon's folder keeps stage 1's log-only
  behaviour). The supervisor rewrites `logs\supervisor.json` every 5 s, and `machine_daemon restart` over ssh asks it by
  `logs\daemon-restart-request.json` before it tries Stop-FFDaemon and the task, so a machine whose Task Scheduler and WMI hang
  still restarts. A log a stuck process still holds is left, and the fresh daemon writes `daemon.held1.log`. The task-state read
  of `machine_daemon start` has a 15 s bound, and Stop-FFDaemon passes a process stuck after its Stop-Process instead of
  refusing. Fixes from #1570's review (w6785): the freeze watch's retry timer no longer stacks, a probe the host probe thread
  cannot take no longer leaves its kind lingering, and "no daemon of it is connected" is said only when none is. Takes effect
  at each machine's next update that rewrites `run-daemon.ps1`. Tests: `supervisorWin.test.ts` (the whole supervisor and the
  ssh route under real PowerShell), `probeGuard.test.ts`. Docs: machines.md ("A daemon stuck mid-exit"), worker-install.md.
