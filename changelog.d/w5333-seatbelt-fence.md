- **A Mac can fence its sandbox agents to the worker root** (w5333, trial; off by default): `"workerFence": "seatbelt"` in
  daemon.json starts each sandbox agent's claude under a macOS Seatbelt profile (`sandbox-exec`), so it and everything it
  starts (Bash, git, batch Unity) write only in `~/ffw` and a few measured exceptions (Unity's `/tmp` sockets, its licensing
  client); the daemon's folder and the secrets stay read-only (the main clone stays writable: sandboxes are its worktrees). docs/worker-fence.md. Needs a daemon update.
