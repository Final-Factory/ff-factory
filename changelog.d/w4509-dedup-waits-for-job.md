- **The privileged helper's `dedup` action waits for the ReFS job before it writes its result** (w4509). `Start-ReFSDedupJob`
  returns as soon as the job starts, so the first full pass on LothDesktop reported "0 min, 49.4 -> 49.4 GB" while it really
  ran 43 min and saved 161 GB. The helper now polls `Get-ReFSDedupStatus` every 30 s until the job stops (bounded by its 5 h
  cap plus 15 min) and reports free space before and after, the duration, savings and `LastRunStatus`; a job that never shows
  as started, or runs past the bound, is reported as failed. Tests: `devdrive.test.ts` (dedup).
