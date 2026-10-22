- **The whole unit suite passes on Windows again** (w1758, lothsahn: "find and fix every recent CI test flake"). The daily
  Windows run had failed every day since 2026-10-11. `benchQueue.test.ts` hung it for 15 minutes (2026-10-22): its stand-in
  for `bench_queue.py` was granted on a 300 ms timer and read after a fixed 50 ms, so on Windows, where node takes longer to
  start, the test read "taking a ticket", failed before its release, and left the helper running with its stderr pipe
  holding the test file's process open. The stand-in is now granted when the test says so and ends when the test's folder
  goes. `videoPreview.ts` takes a program with its first arguments, so its tests run their fake encoder through node (Windows
  spawns no `.cmd` without a shell: every encode there was `spawn EINVAL`). The coordinator brief budget
  (`coordinatorContext.test.ts`) counts the brief with this machine's paths as CI's Linux runner has them: Windows' longer
  temp folder put the dispatcher 15 characters over on 2026-10-21. The file-mode asserts in `appConfig.test.ts` and
  `configMigration.test.ts` skip Windows, which has no POSIX modes; `configMigration.test.ts` and `ask.test.ts` expect the
  native path. The w890 sandbox harness waits for the daemon's link to close before it removes its data folder, as the other
  harnesses in `machineSandboxes.test.ts` do, instead of a fixed 300 ms.
