- **A Dev Drive grow no longer leaves CI runners on the drive offline** (w3721; lothdesktop, 2026-11-08 20:33 UTC: the grow
  from 300 to 320 GB detached V: mid-job, and ffu-lothdesktop-1 and -2 stayed offline in GitHub until started by hand). The
  host guard's grow now waits, as it does for agents and editors, while a GitHub Actions runner whose folder is on the drive
  runs a job ("Dev Drive: grow pending ... once no CI job runs on a runner on the drive"). After the grow it starts again every
  such listener that was up before and is gone (the scheduled task whose action names the runner folder, else its `run.cmd`),
  and reports "Dev Drive: CI runners started again" or "... still down" with the reason. Runners on other drives are left
  alone. Tests: `machineGuard.test.ts` (w3721).
