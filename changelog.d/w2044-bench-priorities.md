- **Bench priorities no longer scan the whole ledger once per worker** (w2044): each minute, and when a daemon connects,
  the portal works out every worker's request priority for each machine's bench queue; it read every request once for
  every worker that machine ever had, and blocked the event loop 1.3 to 1.7 s (stall profiles 2026-10-24 15:38 and
  15:47Z). It now indexes the requests by session once per pass.
