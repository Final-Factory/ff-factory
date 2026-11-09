- **ffu sandboxes: a warm cargo target per slot instead of a cold one per worker** (w3764, lothsahn: "Can we have ffu
  sandboxes like final factory sandboxes but in a different folder?"). A new `ffu-slot` command
  (`eval "$(ffu-slot take --branch <b>)"`, `release`, `list`) leases a worktree of one shared ffu clone per machine
  (`<install>/ffu-sandboxes/slot<N>/ffu`). Each slot keeps its own cargo target (`slot<N>/target`) between workers, up to 4
  slots per machine. A slot is reused only when its holder no longer runs and its work is pushed.

  The clean-up rule `ffu-slot-target` keeps those targets warm:
  - trims a target over 16 GB (`ffuSlotTargetCapGB`), its incremental cache first;
  - drops the target of a slot no running or resumable worker held for 7 days (`ffuSlotIdleDays`);
  - on a low pass, drops unheld slots' targets.

  It never touches a slot's checkout.

  Measured on BEAST: a cold build took 221 s and a warm one 0.6 to 92 s. sccache got 0 Rust cache hits, so it is not used.
  Docs: ffu-sandboxes.md. Tests: `ffuSlots.test.ts`.
