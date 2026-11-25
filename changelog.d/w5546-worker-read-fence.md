- **Workers can't read the daemon's folder, secrets or root.json, on any OS** (w5546, lothsahn: "workers can't read the
  secrets and daemon folders on any OS"). The fences that refuse a sandbox worker's writes now refuse those reads too: a
  Seatbelt `file-read-data` deny on macOS (`workerFence: "seatbelt"`), Landlock read rules in ff-landlock.py on Linux
  (`writeLock`), and a Medium No-Read-Up label set with SetNamedSecurityInfoW on Windows (`workerIntegrity: "low"`; never on
  the system drive). What workers read or run there comes back from one list, `FENCE_READ_ALLOW` (server/daemonReads.ts):
  logs, code, the state files the guard allowed, the gh shim and the Unity MCP status files. root.json and root-backup.json
  left the guard's read list. Applies at each daemon's next start after the deploy. Docs: worker-fence.md ("Reads").
  Tests: workerFence, writeLock (Landlock, on Linux), lowIntegrity.
