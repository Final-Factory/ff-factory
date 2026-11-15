- **`ffu-slot take` trims a slot's cargo target for its new worker** (w4255, ben). Biscuit's held ffu slots reached 27.1 and
  26.6 GB, over the 16 GB cap, because the clean-up keeps a target while its worker builds there, which is nearly always.
  A take by a new worker now removes the cargo units no build read for 3 days, then the least recently read ones until the
  target is under 16 GB. It leaves a target written in the last 15 min, and it runs only where a read moves access times
  (Linux; it skips on APFS). `FFU_SLOT_TARGET_CAP_GB` is now the clean-up's `ffuSlotTargetCapGB` default as well. The ffu
  runners get the same sweep at the end of each CI job (Final-Factory/ffu#803). Docs: ffu-sandboxes.md, self-recovery.md.
  Tests: `cargoSweep.test.ts`, `ffuSlots.test.ts`.
