- **Workers can't read the daemon's folder, secrets or root.json, on any OS** (w5546, lothsahn: "workers can't read the
  secrets and daemon folders on any OS"). The fences that refuse a sandbox worker's writes now refuse those reads too: a
  Seatbelt `file-read-data` deny on macOS (`workerFence: "seatbelt"`), Landlock read rules in ff-landlock.py on Linux
  (`writeLock`), and a Medium No-Read-Up label set with SetNamedSecurityInfoW on Windows (`workerIntegrity: "low"`; never on
  the system drive). What workers read or run there comes back from one list, `FENCE_READ_ALLOW` (server/daemonReads.ts):
  logs, code, the state files the guard allowed, the gh shim and the Unity MCP status files. root.json and root-backup.json
  left the guard's read list. Applies at each daemon's next start after the deploy. Docs: worker-fence.md ("Reads").
  Tests: workerFence, writeLock (Landlock, on Linux), lowIntegrity.
- **The read fence can be switched off live, with nobody at the machine** (w5546, lothsahn's fallback for an update the
  fence might stop): `machine_daemon` action `read-fence-off` (and `read-fence-on`) writes or removes `read-fence.off` in
  the daemon's folder; runs started after it get no read rules, and Windows drops No-Read-Up from its labels. No restart.
  Only daemons whose hello offers `readFenceSwitch` are sent it, and a daemon now refuses a control action it does not know
  instead of taking it as an unload. Files workers read that the daemon rewrites are written in place, each run's App
  tokens sit in a folder of their own, and the given-back folders are made before the fence is set, so none of them turns
  unreadable mid-run on Linux or Windows.
