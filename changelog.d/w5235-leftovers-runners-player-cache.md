- **`ff-leftovers` judges idle FFU runners' job folders and the shared player cache** (w5235, after biscuit's clean-up w5233
  stopped at 16 GB free of 30 with 25 GB in an idle runner's `_work` and 11 GB of cached players, all "not a place with an
  owner in the ledger"). `folders`, `check` and `remove` now list an FFU runner's `_work/<job folder>` (never `_tool` or
  `_actions`) as DELETE while that runner runs no job and nothing in it was written for 15 min, the daemon's
  `ffu-runner-work` rule, and a cached player (`player-cache/<sha>-<os>`) as DELETE when no process, pin, slot in use or
  worker with a request not closed uses it, it was not used in the last hour and it is not one of the 2 newest builds.
  The `player-cache` folder itself is fenced like the other top folders. Docs: self-recovery.md. Tests:
  `w5235RunnerPlayerCache.test.ts`.
