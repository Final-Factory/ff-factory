- **ffu slot targets stay bounded: a released slot is swept to its last hour of builds, and the incremental trim is no
  longer lost** (w5503, lothsahn: "Please fix the ffu build output not being capped or cleaned"). On LothDesktop, 2026-11-25,
  the slot targets were 4.1 to 32.1 GB and the sweep's 48 h window freed 0 GB from every one of them (dry run, measured).
  Three changes to the clean-up rule `ffu-slot-target`:
  - A slot no running or resumable worker holds is now swept to what its last worker built in its last hour
    (`ffuSlotReleasedKeepHours`, 1). The dependencies that build used stay warm. Before, older variants stayed up to 16 GB
    for a week; on slot2, 8.8 of its 12.8 GB was units no build of the last hour used.
  - The cap is weighed without an incremental cache that the w5499 trim takes on the same pass anyway, so the sweep no longer
    narrows to 1 h and deletes warm units because of it. Over the cap, the window now narrows past 1 h to 15 min.
  - When one pass both sweeps a target and trims its `debug/incremental`, the trim joins the sweep's item. Before, the plan
    dropped it as an item inside another, so a slot swept on every pass kept its incremental cache.

  Applies at each daemon's update. Docs: ffu-sandboxes.md. Tests: `ffuSlots.test.ts`.
