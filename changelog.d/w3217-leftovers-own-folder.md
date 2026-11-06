- **`ff-leftovers` never marks a running worker's temp folder DELETE** (w3217, ben; found in w3213's LothDesktop clean-up,
  which deleted its own `ffa-9aad7b21`). Its `folders` ran 44 s after its session started, on facts written before the
  session existed (accepted up to 5 min old), so no fact named it. A session folder is now KEEP when it was made or written
  after the facts, when it is the asking worker's own (`FF_SESSION_ID`), or when its agent host process runs; the daemon's
  facts count every running agent host, adopted or not. **`remove-slot`** now takes the names `check` prints (`slot3-0`),
  `players/slot3-0` and backslash paths, and says when a shell ate the backslashes. The `timing/` row says whether a timed run
  plays or waits on the machine. Tests: `cleanupFolders.test.ts` (w3217).
