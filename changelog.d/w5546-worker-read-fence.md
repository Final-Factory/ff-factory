- **Workers can't read the daemon's folder, secrets or root.json, on any OS** (w5546, lothsahn: "workers can't read the
  secrets and daemon folders on any OS"). The fences that refuse a sandbox worker's writes now refuse those reads too: a
  Seatbelt `file-read-data` deny on macOS (`workerFence: "seatbelt"`), Landlock read rules in ff-landlock.py on Linux
  (`writeLock`), and a Medium No-Read-Up label set with SetNamedSecurityInfoW on Windows (`workerIntegrity: "low"`; never on
  the system drive). What workers read or run there comes back from one list, `FENCE_READ_ALLOW` (server/daemonReads.ts):
  logs, code, the state files the guard allowed, the gh shim and the Unity MCP status files. root.json and root-backup.json
  left the guard's read list. Enforced only where the read fence's mode is set to `on` (below); off by default. Docs: worker-fence.md ("Reads").
  Tests: workerFence, writeLock (Landlock, on Linux), lowIntegrity.
- **The read fence is off by default, with a warn-only stage, and its mode is set live** (w5546 lockout review, lothsahn's
  rule: "warn-only first, enforce only after measured zero failures, keep a recovery route that needs no person"):
  `machine_daemon` action `read-fence-off`, `read-fence-warn` or `read-fence-on` writes the mode to `read-fence` in the
  daemon's folder, with no restart. `off` (every machine until set) gives runs no read rules and takes any No-Read-Up label
  off on Windows, so a switch or a revert leaves none behind. `warn` probes the fence in a child of the daemon's own at start
  and at each switch (opening each path, reading nothing) and logs what it would refuse that workers need and what it would
  leave open. `on` enforces only once a probe passed. Only daemons whose hello offers `readFenceSwitch` are sent it, and a
  daemon now refuses a control action it does not know instead of taking it as an unload. Files workers' tools read that the
  daemon rewrites are written in place, each run's App tokens sit in a folder of their own, and the given-back folders are
  made before the fence is set. A Dev Drive install's real secrets folder (in the host folder) is closed too.
