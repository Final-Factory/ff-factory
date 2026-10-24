- **The orchestrator-memory backup no longer holds the portal's event loop** (w2044): `backupMemory` and the trash pass read,
  copy, fsync and rename with `fs.promises`, and a pass still running is joined instead of started twice. Its synchronous copy
  with an fsync per file held the loop 4.8-5.5 s every ten minutes (stall profiles, 2026-10-24 12:20Z and 12:30Z).
