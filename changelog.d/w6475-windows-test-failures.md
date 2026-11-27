- **The players broker and the slot caches write their files over a planted junction on Windows** (w6475, lothsahn). A
  rename never replaces a junction there (EPERM), and a Low worker makes one with no privilege, so a junction at a broker
  slot file or a cache marker made every later write of it fail. `writeFileSafe` now removes the junction itself (never
  its target's files) and renames again. Also: the 12 ff-factory tests that failed on BEAST's full Windows run (run U,
  2026-11-27) pass or skip with a reason there: workerCopy's links are junctions on Windows and its copies go through the
  Low node route; the Linux editor fence tests skip on Windows; the daemon source check reads past CRLF; start-portal.sh's
  test runs the workers' Git Bash at Low integrity; the w6240 cargo fixture names its test binaries `.exe` on Windows.
  Tests: `workerCopy.test.ts`, `w5631LinuxEditorFence.test.ts`, `instance-priority.test.ts`, `ffuSlots.test.ts`.
