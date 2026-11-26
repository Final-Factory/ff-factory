- **The path fence, on** (w5899, macOS and Linux): the unity-slot shims (unity-slot, ff-pr, ff-leftovers, ffu-slot,
  python), first on every agent's PATH, move from the Unity slots mailbox's `bin`, which fenced workers could write, to
  `<root>/tools-medium/shims`, which they cannot. Agents started before the move keep the old folder, as one link to the new one (the
  daemon's shims), until they end; a `writeLockExtra` folder over a locked one is left out of the Linux lock. `on` is the
  default; `ops_worker machine_update path_fence off` is the recovery. Docs: `docs/worker-fence.md`, "The agents' PATH
  folders".
