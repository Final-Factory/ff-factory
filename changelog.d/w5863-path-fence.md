- **The path fence, warn-only** (w5863, macOS and Linux): the daemon logs each change in the unity-slot shims folder
  (first on every agent's PATH, fenced or not) that it did not make, `path fence (warn): ...`; nothing is refused yet.
  The later enforce stage moves the shims to `<root>/tools-medium/shims`, which both worker fences already keep
  read-only. Off switch: `ops_worker machine_update path_fence off`. Docs: `docs/worker-fence.md`, "The agents' PATH
  folders".
