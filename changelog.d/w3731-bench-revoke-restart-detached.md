- **A revoked bench ticket can no longer outlive a daemon restart, and a bench command can no longer start detached**
  (w3731; lothsahn: "Make sure that this situation can never happen again… get it fixed"). The daemon's start rescans its
  bench queue and ends the helper of any worker ticket revoked 90 s or more ago that still runs (a younger revoke gets the
  rest of its 90 s), where before the restart lost the timer and the helper kept the lock. The worker guard refuses
  `bench_queue.py timed`, `run` or `--acquire` (and the other ticket-taking bench commands) behind nohup, setsid, disown, a
  trailing &, start /b, Start-Process, screen or tmux, and points the worker to the Bash tool's run_in_background; other
  nohup and & use passes. Tests: `benchRevokeRestart.test.ts`, `benchDetachGuard.test.ts`.
