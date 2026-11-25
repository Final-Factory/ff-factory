- **ffu slot targets are capped on every hourly clean-up pass** (w5503, lothsahn: "Please fix the ffu build output not being
  capped or cleaned"). The `ffu-slot-target` rule ran only in the full plan, which the daemon builds on the daily stale pass
  or when the drive is under its soft threshold, so #1148's sweep and the incremental trim waited up to a day: after it
  deployed, LothDesktop's 05:34 UTC hourly pass on 2026-11-25 left slot2 to slot4 at 25 to 35 GB (11 to 21 GB of it an idle
  incremental cache, measured). It now runs in the hourly `cargo-cap` scope too. Test: `ffuSlots.test.ts`.
