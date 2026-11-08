- **A timed run no longer stops a machine's disk clean-up once the disk nears its warn line** (w3700). The daemon skipped every
  clean-up tick while a timed run was in flight, queued and fetching included: on LothDesktop on 2026-11-08 no pass ran from
  16:23 to 18:18 UTC while V: fell from 58.6 to 14 GB free, and the host guard stopped every new editor and agent. A timed run
  now defers a pass only while the disk keeps `disk_warn_gb` + 5 GB free (`CleanupRunnerDeps.hold`, `cleanupHoldFloorGB`),
  and the daemon logs the deferral once.
- **The sandbox guard refuses a PowerShell command that names the install folder in Git Bash's spelling** (`/v/ffw/...`),
  which PowerShell reads as `V:\v\ffw\...`, outside the install folder: three workers' temp folders had grown in
  `V:\v\ffw\tmp` on LothDesktop (server/gitBashPath.ts). Tests: `w3700DiskFill.test.ts`.
