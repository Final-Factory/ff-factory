- **A finished dev request's update is no longer sent to FFBox again every minute** (w1640; `show dev_requests` showed
  "done, no merge" updates for w1297 and w1333 every minute). What FF Factory last sent was kept per FFBox conversation,
  so two requests linked to one conversation each found the other's update there and both were sent again on every
  minute's recheck. It is now kept per request and conversation; a record kept the old way still counts once, so the
  change sends nothing again. Test: `devRequests.test.ts` (w1640).
