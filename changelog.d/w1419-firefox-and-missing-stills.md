- **A still named slightly wrong in an orchestrator's message still shows, and Firefox is tested** (w1419, Ben: "i dont see any
  previews"). The outgoing check (w1384) points an image whose review file is not there at the file it was meant to be (the
  same name but for case, spaces, `_`/`-` or the extension), or shows its alt in words with the folder's stills and clips.
  The e2e review folder now sits outside the sandboxes, as `/srv/fff/review` does on the portal, so the chat's stills are
  tested through `/api/image` as Ben's are; a `desktop-firefox` project runs the image, video and question specs, in CI's
  Chromium leg. Tests: `e2e/images.spec.ts` (w1419), `reviewMedia.test.ts`.
