- **A chat pinned to the bottom keeps following when the layout moves it** (w1758): a scroll event that comes with the chat's
  size changed and no wheel, touch, pointer or key from the reader in the second before is the layout's, not the reader's.
  On CI, a block above drawn smaller while a picture at the end loaded moved the last row a few px, and the chat stopped
  following 236 px short of the end, in Chromium too.
- **A chat scrolled up comes back where the reader last saw it on iPhone and iPad** (w1758): when pictures or diagrams above
  load under a reader scrolled up, WebKit moves the rows without a scroll event; the remembered place now follows what is
  on screen, as Chromium's scroll anchoring makes it.
- **The end-to-end tests stopped failing on flakes** (w1758): the tests that tap a chat's buttons or keep its place run on
  logins of their own (`replier`, `reloader`), the orchestrator screenshot hides the global notice bars, the test server
  keeps idle connections 65 s (Playwright's never time out, and the server's 5 s cut requests off: `ECONNRESET`), and the
  test timeout is 60 s (the slowest passing WebKit test took 30.2 s on CI, measured).
