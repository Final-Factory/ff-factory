- **The release pass reads the sessions once for its light-folder sweep** (w6769, lothsahn: "no event-loop block over 1 s on
  the live portal"). `PlaceAgain.lightSweep` copied and filtered every session in the store for each light agent folder; it
  now groups them by computer and folder once per pass. It was the release pass's largest own time in the stall profiles
  (21 s of its 267 s of blocks, 05-12Z on 2026-11-28). Same folders deleted and kept. Tests: `lightFolders.test.ts`.
