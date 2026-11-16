- **`ff-leftovers check` and `folders` judge ffu slots' build output** (w4422). A released, idle slot's `target` (or a path
  in it, such as `debug/incremental`) is DELETE with the reason, as the daemon's rule `ffu-slot-target` judges it; a slot a
  running or resumable worker holds, or one a process names or that was written within 15 min, is KEEP with the reason.
  A stray `target/` inside a released slot's checkout (`slot<N>/ffu/target`, from before the w4258 routing) is DELETE only
  with cargo's `CACHEDIR.TAG`; nothing else in a checkout ever is. On biscuit (w4283) both paths said "not a place with an
  owner in the ledger". Docs: ffu-sandboxes.md. Tests: `ffuSlotCheck.test.ts`.
