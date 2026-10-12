- **An FFBox dev-request thread closed as "already fixed by PR #N" hears which fix and which build, and is filed away** (w1143,
  lothsahn: "make sure that when bug reports are already fixed we put a message and close them through ffbox"). w1088 closed
  `already fixed by PR #1075 (w432, ...; follow-ups PR #1095 and PR #1229)` and its #bug-reports thread heard nothing: the fix of a
  finished request was learnt only for escalated threads and reports (`resolveFixes`), and `fixedByPr` gave up on the follow-up PRs.
  Now `resolveFixes` also learns the fix of finished requests FFBox dev-request threads link to (closed since 2026-10-12 04:00 UTC;
  older threads are back-filled through FFBox one by one), `fixedByPr` reads text in parentheses as an aside, and a done
  `dev_update` carries the fix's `pr` beside its merge and release, so FFBox posts "Fixed in PR #1075, in build 78 and later." and
  archives the thread. Needs a portal deploy.
