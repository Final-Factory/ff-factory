- **ffu build folders stop refilling workers' disks** (w4258, lothsahn: "A worker that holds an ffu slot builds in that
  slot's target and never in a private $TMPDIR/ffu-target"). LothDesktop's clean-up log of 2026-11-15 showed slot targets of
  29.8, 29.3, 20.9 and 10.5 GB, the two biggest kept whole for hours because a test binary ran from them, beside a worker's
  own 4.9 GB `ffu-target`. Now: (1) the clean-up sweeps each slot target's stale units on every pass, a mark and sweep over
  cargo's fingerprints (`server/cargoGraphSweep.ts`): what no workspace build of the last `ffuSlotKeepHours` (48) uses goes, and
  on macOS superseded `.rcgu.o` objects; over the 16 GB cap or on a low pass the window narrows to 24, 6, 1 h before the
  incremental cache or the whole target is touched. (2) A test binary running from a target no longer keeps it whole: the
  sweep spares the units it runs, and a held or running target is never taken whole. (3) Each slot gets a
  `.cargo/config.toml` naming its target, the guard refuses a slot holder's `CARGO_TARGET_DIR`/`--target-dir` into its temp
  folder, and the clean-up takes such a worker's temp-folder targets once cargo is done with them. Applies at the daemon's
  next update. Docs: ffu-sandboxes.md, self-recovery.md. Tests: `cargoGraphSweep.test.ts`, `ffuTargetGuard.test.ts`,
  `ffuSlots.test.ts`.
- **A slot target in steady use is swept too** (w4258 follow-up): LothDesktop's first pass on the sweep (2026-11-15 03:29,
  26.3 GB free) freed nothing from 71 GB of slot targets and logged none of them, because a write within 15 min kept a
  target from the sweep and a busy target was named only on a low pass. Now only a running build stops the sweep; a recent
  write stops the trims and whole removals only, and a target kept over the cap is named on every pass.
