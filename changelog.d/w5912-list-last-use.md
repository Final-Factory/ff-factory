- **`ffu-slot list` shows the same last use as the portal** (w5912). Its third column was the stamp a `take` wrote in
  `slots.json`, while the portal's ffu slots and the staleness check read the slot's real last use (`slotLastUsed`: the
  checkout's git index and HEAD, the target's build folders). On biscuit slot1 read 2026-11-23 in the list and 2026-11-26
  on the portal. Both now print `slotLastUsed`. Test: `ffuSlotsReport.test.ts`.
