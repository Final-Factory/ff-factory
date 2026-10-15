- **Review media reaches a person inline, never as a bare path** (w1384, Ben: "Stop giving me paths to videos and inline the
  videos like you should be doing and I've reminded you as such like 100 times"). `server/reviewMedia.ts` resolves what a
  text names on the portal's review folder: a folder becomes its stills and clips, newest first, without `.preview/`; a bare
  or relative file name becomes its absolute path; a file name cut off mid-word becomes its folder's files. A `[needs you]`
  now lists each as `![name](<absolute path>)`. That fixes w1182's bare fog folder and w1241's `glow_800_closeup.jp`. Every
  reply a person's own orchestrator writes is checked before it is kept and shown (`Store.assistantText`): a folder, a
  wildcard, a bare or relative name or a cut-off name it gives is added inline under the paragraph that names it (a whole
  path to an existing file the page's strip shows already). The reply is rewritten, not sent back, because it has already
  streamed to the page by then. The orchestrator's brief now has the rule in bold, with Ben's words. Docs: orchestrators.md
  ("Review media inline"). Tests: `reviewMedia.test.ts`, `orchestrators.test.ts` (w1384), `needsYou.test.ts`.
