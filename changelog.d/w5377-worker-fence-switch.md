- **`machine_update` takes `worker_fence on|off`, the remote switch for a machine's worker write fence** (w5377): `ops_worker`'s
  `machine_update` can turn the fence on or off with nobody at the machine, over the daemon's link or over ssh. The installer's
  update takes `-WorkerFence on|off` (Windows) or `--worker-fence on|off` (Mac, Linux) and sets or removes that platform's key in
  daemon.json (`workerIntegrity: "low"` on Windows, `workerFence: "seatbelt"` on macOS, `writeLock: true` on Linux; `writeLockExtra`
  stays), printing `worker fence: on (<key>)` or `worker fence: off`. Left out, an update carries the fence as it is. Off is the
  emergency switch when a fence breaks work; the daemon reads daemon.json at its restart, which the update does.
- **A worker write fence that cannot apply is left off, and the daemon says so** (w5377): before its first sandbox agent, the
  daemon runs a no-op inside the fence once (Seatbelt on macOS, the Landlock write lock on Linux). If it does not exit 0 within
  15 s, `logs/daemon.log` says why and agents run unfenced, so a fence never stops the daemon or an agent's start.
  docs/worker-root.md 4.3 has the off-switch steps per OS.
