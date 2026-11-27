- **The clean-up no longer deletes an ffu slot's test binaries under a running test run** (w6240). On biscuit, 2026-11-27, the
  stale-unit sweep took 12.0 GB of slot4's target at the 15 min window, 62 of its 257 test binaries among it, while the
  holder's `python3 tools/run_tests_parallel.py` was running them; the run died with FileNotFoundError. Now: (1) anything
  running from a slot keeps its whole target, judged by each process's command line, executable and working folder
  (`server/procPlaces.ts`: `/proc` on Linux, `lsof` on macOS, Win32_Process on Windows), checked on the plan and again right
  before each removal, and unreadable processes keep it; (2) the sweep roots the newest test binary and bin of each name in
  `deps/` however old, since cargo rewrites nothing of a unit that is already up to date. The trim only keeps more than
  before. Applies at the daemon's next update. Docs: ffu-sandboxes.md, self-recovery.md. Tests: `ffuSlots.test.ts`,
  `procPlaces.test.ts`.
