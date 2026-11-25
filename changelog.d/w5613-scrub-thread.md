- **The start-up secret scrub no longer holds the portal** (w5613, lothsahn: "Portal start-up secret scrub blocks the event
  loop up to 10 s"). After w5526's scrub version 3 the pass over the data folder held the event loop for up to 10.0 s on one
  big transcript (journal, 2026-11-25). The walk, reads, masking and zipping now run on a thread of their own
  (`server/scrubThread.ts`); the portal's thread only swaps each masked file in, in one turn, and keeps what it appended
  meanwhile, masked (`commitScrubbed`). The marker `secret-scrub.json` means what it did. The scrub's last line now says how
  long its longest piece on the portal's thread took (4 to 7 ms over a 30 MB + 15 MB + 10 MB fixture, measured). Docs:
  vault.md section 14. Tests: `server/scrubThread.test.ts`.
