- **`server/workerFence.test.ts` passes on Windows, and the Windows job runs it** (w5808): 9 of its tests failed on a
  Windows host on path separators. The macOS Seatbelt profile and `fenceEnv` now join their paths with `path.posix` on every
  host (on macOS `path` is `path.posix`, so the profile there is byte-for-byte the same; off macOS the fence is never built),
  and the read-fence tests compare Windows paths as Windows answers them. `.github/windows-tests.txt` and `windows.yml` now
  list the file, `server/workerFence.ts` and `machine/readFence.ts`.
