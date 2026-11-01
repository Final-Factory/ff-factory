- **`ff-leftovers` frees a held worker's capture frames and judges player slots by their leases** (w2796, ben: "let disk
  clean-up free space that the current rules lock up"). In a finished worker's folder (the 7-day reopen hold keeps it, w2223),
  a folder of 100 or more frame images with no clip, note or other evidence beside it is a capture's frames: it goes on the
  w2223 clock (no write for 24 h, 15 min while disk is low), in the daemon's sweep and as a DELETE row of `ff-leftovers
  folders`/`check`, while the stills, clips and notes published nowhere else stay. A `<root>/players/slot*` folder is now
  KEEP while a live lease holds it, a launch is filling it or a running process plays from it, and DELETE otherwise
  (it said "not a place with an owner in the ledger" before). Docs: self-recovery.md. Tests: `finishedBulk.test.ts`,
  `cleanupFolders.test.ts`.
