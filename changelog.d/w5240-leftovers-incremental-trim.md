- **`ff-leftovers` trims a stopped worker's incremental cache from an ffu slot's cargo target** (w5240, biscuit's disk went
  critical again at 8 GB free, an hour after w5233). A slot held by a worker that has stopped but whose request is not
  closed kept its whole target KEEP between jobs, so `folders` could reclaim nothing from slot1 (5.9 GB of its 18.5 GB was
  `debug/incremental`). `folders`, `check` and `remove` now list `target/debug/incremental` of such a slot as DELETE once no
  process names the slot and it was not written for 15 min; the warm units stay, a running worker's target stays whole, as
  the daemon's slot-cap trim already treats it. Tests: `ffuSlotCheck.test.ts`.
