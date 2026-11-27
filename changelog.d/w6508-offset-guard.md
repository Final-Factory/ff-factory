- **An agent host's saved offset survives a restart that races an earlier save** (w6508, after w6499's review of
  w6486). The poll's async write of `daemon.offset` now opens the file, checks the host has not started again since, and
  writes nothing if it has. Before, a write from the first start that landed after a new start (and after the daemon
  saved on its way out) could leave the first start's larger offset, and the next daemon would skip the new host's first
  lines. The write is now done in place, then cut to length, so the file is never empty mid-write. `norm` no longer keeps
  its answer for a UNC path with no share, which depends on the working folder's drive. Tests: `hostWatch.test.ts`
  (fails without the check: 42 read where 14 was right), `cleanupNested.test.ts`.
