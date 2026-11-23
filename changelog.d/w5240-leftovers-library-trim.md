- **`ff-leftovers` lists an idle sandbox's stale Unity Library cache entries** (w5240; biscuit's slot1 and slot2 held 24 and
  25 GB of `Library/BurstCache` that no `folders` row reached). `folders`, `check` and `remove` now list the entries the
  daemon's own trim calls stale (`cacheTrim.ts staleCacheEntries`: superseded Burst player builds, old BuildCache folders;
  the newest builds, JIT, Artifacts and Bee stay) as DELETE while no worker is in the sandbox or waits on a request there, no
  editor or batchmode build has it open (`Temp/UnityLockfile`) and no process names it. The cache itself is never a row, so
  no cold Unity start. Tests: `ffuSlotCheck.test.ts`.
