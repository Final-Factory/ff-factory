- **The daemon's clean-up now trims the timed runner's folders and the FFU runners' job folders** (w3502, after w3482 freed
  them by hand on LothDesktop: V: at 14.2 GB free). `<root>/timing/builds/*` goes once untouched a day and, below the soft
  threshold, `<root>/timing/cache/*` too, only while no bench ticket with reason timing is held or waiting and no timed run
  is in flight. `<root>/ffu-runners/<runner>/_work/*` (not `_tool`, `_actions`) goes once untouched 14 days, or 15 minutes
  in a low pass, only while that runner runs no job. A low pass reaches both with no person's go and logs what it kept and
  why. An editor start on a cold Library under `disk_warn_gb` + 18 GB now warns that the re-import may cross the line.
  Docs: self-recovery.md. Tests: `w3502TimingRunnerCleanup.test.ts`, `machineSandboxes.test.ts`.
