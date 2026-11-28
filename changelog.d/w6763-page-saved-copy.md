- **A fresh page load draws its saved copy at once and gets only what changed** (w6763): the page keeps its last live state
  in IndexedDB (saved at most once a minute while visible, and as the tab is hidden or closed; cleared at sign-out), draws
  it on the next load before any socket opens, and its first socket sends that copy's sessions rev and parts' hashes as a
  reconnect does, so the server sends the delta instead of the 4.3-4.6 MB whole state. The page then shows what a fresh
  load shows (server/pageCache.test.ts). A copy is drawn only by the same web build within 24 h; the banner says "Showing
  the copy saved at HH:MM" until the socket is live. The `page socket ready` line adds `script at` and `saved copy on
  screen at` (docs/portal-logs.md). Needs a portal deploy.
