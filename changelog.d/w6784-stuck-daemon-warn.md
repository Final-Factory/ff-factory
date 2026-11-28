- **A Windows daemon stuck mid-exit is now logged, and so is a pile-up of stuck probes** (w6784; lothsahn asked for
  "self-healing wherever it's safe" after BEAST stayed offline from 2026-11-28 07:41Z with its daemon half-exited after the
  freeze watch's SIGKILL). This is the warn-only stage. The daemon writes `logs\daemon-ending.json` before that kill and at
  every exit. `run-daemon.ps1` waits in 5 s steps and writes `... is stuck mid-exit` to supervisor.log once the daemon said it
  ends and is still there 2 minutes later. `machine_daemon start` says when the task was already running, so the start changed
  nothing, and when no daemon of it is connected. Every program run with a timeout is now a probe of a kind
  (`server/probeGuard.ts`). One still alive 10 s after its timeout's kill is logged, and a new one of that kind is logged as one
  `FF_PROBE_GUARD=enforce` would not start. The default is `warn`, which starts it anyway. Takes effect at each daemon's next
  update, and the supervisor at the next install or update that rewrites `run-daemon.ps1`. Docs: machines.md ("A daemon stuck
  mid-exit", "The probe guard"), worker-install.md. Tests: `probeGuard.test.ts`, `machineDeployWin.test.ts`,
  `freezeWatch.test.ts`.
