- **`ff-leftovers check` no longer keeps every player slot for "a running process plays from it"** (w3204, ben; found in
  w3201's LothDesktop clean-up). The process naming the slot was the check itself (`node leftovers.ts check <slot>`) and
  the shells that ran it, so `check` said KEEP for every slot, one that did not exist included, while `folders` said
  DELETE. The slot verdict now leaves out its own process and its parent chain (by ppid and the shim's
  `FF_LEFTOVERS_CALLERS`). New **`ff-leftovers remove-slot <slot>...`** empties an idle player slot the way
  `player_slots.py prune` does (its `player/`, `slot.json` and dead lease files; the folder and `leases/` stay): refused
  while a lease lives, a fill runs or a process plays from it, and it looks again after moving `player/` aside. Docs:
  self-recovery.md. Tests: `cleanupFolders.test.ts` (w3204).
