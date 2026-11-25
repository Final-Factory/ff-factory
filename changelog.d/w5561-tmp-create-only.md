- **A locked Linux worker can no longer change files in `/tmp`** (w5561, lothsahn: "probe first, then close /tmp and
  /dev/shm to Linux workers where nothing breaks"). `/tmp` is now create-only under the write lock: new files and sockets
  and removing them, no write, truncate, folder or link; only `/tmp/.dotnet` stays writable. Unity still needs `/tmp`
  for its sockets and shader compiler lock whatever TMPDIR says, and a private `/tmp` needs a mount namespace, which
  biscuit refuses. `/dev/shm` stays writable: Python's multiprocessing and Chromium fail without it. Docs: worker-root.md
  4.2. Tests: `writeLock.test.ts`. Needs a daemon update.
