- **A page no longer stays "Connection lost" on one hung socket attempt** (w5318, lothsahn: "You were just unavailable for
  a long time. Please figure out why."). On 2026-11-23 lothsahn's page had no live socket from 18:53:06 to 19:07:17Z
  while their orchestrator answered in 11 s: Tailscale Funnel was failing, and an attempt through it can hang without
  ever closing. The page replaced only open, silent sockets, so one hung attempt held it. Now an attempt not open after
  10 s is abandoned and tried again (a tab coming back or the network returning retries at once), the "is my login still
  good" state fetch after a failure gives up after 30 s, and the open line logs `why=timeout` and `tries=<n>`. Applies on
  a page's next load after the portal deploy. Docs: portal-logs.md. Tests: `socketPolicy.test.ts`,
  `pageSockets.test.ts`, `e2e/socketHang.spec.ts` (red without the fix).
