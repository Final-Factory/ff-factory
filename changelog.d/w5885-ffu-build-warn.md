- **A worker that builds ffu without a slot is told to wait for one** (w5885, warn-only): a cargo build, test, check, clippy,
  run or bench outside the machine's ffu slots, by a worker holding none, adds a note to its next step (once per 30 min)
  to take a slot or wait for one, never to build in its temp folder. `server/ffuSlotBuildHook.ts`.
