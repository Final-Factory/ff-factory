- **The Linux unit run fits under its 10-minute watchdog again** (w5619). On 2026-11-25 PR runs began ending in "WATCHDOG:
  the run is still going after 10 min". Two test files kept their process alive long after their tests: attachmentFlow
  282 s (a worker's attachment download still retrying after the test stopped) and procsBroker 61 s (stopTree's real
  60 s SIGKILL timer); the new check then found liveIdleDaemon 59 s (an idle close's 60 s timeout, unanswered when the test ended). Each held one of the runner's 3 test workers that whole time, on a suite that had grown from 376 s
  (median, 2026-11-01) to about 550 s. Both tests now wait for what they start. CI prints the slowest test files, and the
  new "Test files' time" step fails when a file's process outlives its tests by more than 45 s
  (`scripts/test-file-times.ts`).
