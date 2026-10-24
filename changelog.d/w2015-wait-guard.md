- **The worker guard refuses waits that never work** (w2015, lothsahn: "stop workers wasting calls on waits that never
  work"). `gh pr checks` and any gh call naming `statusCheckRollup` are refused ("a fine-grained token cannot read checks: use
  ff-pr status, or blocked_on ci:<repo>#<n>"): under a vault token they always fail, and workers made 56 such calls in 5 days
  on beast (w2008's report, measured). A Bash or PowerShell command whose only work is waiting on the clock (sleep or
  Start-Sleep, a loop that tests only $SECONDS, `date +%s`, Get-Date, `true` or a counted `for`) and that can last over 180 s
  (run_in_background, or a timeout over 180000 ms, not capped by its own numbers) is refused too ("use wake_me, or blocked_on
  for CI"). A loop that tests what it waits for and a sleep beside real work (a build retry) pass (`server/waitGuard.ts`).
  Applies to workers started after the machine's daemon update. Tests: `waitGuard.test.ts`.
