- **Portal page connects and reconnects are faster** (w6336, lothsahn: connecting and reconnecting took about 10 s; get it
  under 1 s).
  - The placement check that blocked the portal for 4–8.5 s every 10–15 s now reads each machine once per pass (#1437).
  - A page now retries within 2 s of a restart, where it used to wait up to 15 s (#1439).
  - A failed attempt no longer fetches the whole state while the page's copy is fresh (#1439).
  - A reconnect now resends only the parts and requests that changed, matched by content hash, so this also holds across
    a restart.
  - A state build is one placement pass.
  - Every connect logs a `page socket ready` line with the page's own phase times.
