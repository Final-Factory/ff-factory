- **An instance portal stays responsive on a fully loaded machine** (w6221): `scripts/instance/new.ts` registers the logon
  tasks with `-Priority 4` (the default 7 starts them at BelowNormal CPU, low I/O and low memory priority), and the
  start-portal.sh it writes starts the portal in the background, raises its node to AboveNormal CPU with normal I/O and
  memory priority (inline PowerShell, no elevation; a .ps1 would not run under BEAST's AllSigned policy), then waits for it
  so the task still ends with the portal's exit code. On BEAST at 99.9% CPU Lens Scout's portal read BelowNormal, I/O 1,
  memory 2, its file opens took 10-35 s and /api/health 18-48 s. Existing instances pick it up when their start script is
  rewritten; a task registered elevated needs an elevated shell to change its priority.
