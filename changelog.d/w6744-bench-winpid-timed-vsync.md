- **bench_lock from Git Bash on Windows gets its ticket again** (w6744, seen in w6726 on BEAST: every call answered
  "ownerPid … is not running"). quiet_gate.sh's bench_lock sends its MSYS pid as `ownerPid` and its Windows pid as
  `ownerWinpid`; the daemon's `bench/take` checked only `ownerPid`, which no Windows process has. It now takes the owner
  as running when either pid is alive (the helper already follows `ownerWinpid`), and refuses only when neither is.
  Tests: `daemonRpc.test.ts` (w6744).
- **timed_run's legs hold vsync and the frame cap off** (w6744), as the game repo's probe_ab_win.sh does by default
  (`-ffFeelProbe -ffFeelVsync 0 -ffFeelFps -1`): a leg on a 60 Hz screen read the cap, 16.7 ms on every arm. A variant's
  own `-ffFeelVsync 1` comes after and still measures capped. Applies to the next timed_run after a deploy. Tests:
  `timedRuns.test.ts`.
