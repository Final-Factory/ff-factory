- **Windows machines log the priority their ffu CI runners run at, as a first step toward Normal** (w6163). A runner
  started through its scheduled task runs at task priority 7: BelowNormal class, I/O Low and memory priority 2. Its jobs
  inherit all three (both LothDesktop workers were logged at BelowNormal on 2026-11-26 17:46Z, w6110). At logon the runner
  starts from the Startup folder at Normal instead.
  - `machine/runnerPriority.ts` reads each ffu runner's task priority. It also reads the class, I/O and memory priority of
    the listener and of the cmd.exe and conhost.exe it runs under, and logs `runner priority:` lines.
  - In `enforce` it sets the task to 4 (the only priority that starts a process at full Normal). It raises those processes
    to Normal in all three, so the jobs started after that run at Normal. Nothing is restarted.
  - This step enforces nowhere (lothsahn's lockout rule: warn first). BEAST stays log-only (Ben's hold on its system
    settings).
  - daemon.json `runnerPriority` (`off`, `warn`, `enforce`) overrides the default at the daemon's start.
  - ffu #1204 registers new tasks at 4.

  Needs a daemon update.
