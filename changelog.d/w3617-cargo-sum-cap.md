- **The cargo target cap counts all of a worker's targets together** (w3617, lothsahn). A worker that made a new cargo
  target per leg slipped past the 8 GB per-target cap (12 targets, 22 GB on biscuit). The hourly clean-up now caps the sum
  of one worker's targets: the oldest idle ones lose their incremental cache first, then whole idle targets go, oldest
  first; a target a running cargo uses is never touched.
