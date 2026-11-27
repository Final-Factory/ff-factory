- **The daemon says its event loop is frozen while it is frozen** (w6555, after w6546: BEAST's daemon held its loop 891 s on
  2026-11-27 and its log said nothing until the block ended). A thread of its own (`machine/freezeWatch.ts`) reads a beat
  the main loop writes once a second. After `freezeWatch.afterMin` minutes with no beat (daemon.json, default 3) it writes
  `event loop: frozen for N s so far ...` to daemon.log with the main thread's stack, read over the in-process inspector, and
  says it again every `repeatMin` (default 5) while the freeze lasts. This stage only logs; ending the process so the
  supervisor restarts the daemon is the next PR. `freezeWatch: false` or `FF_FREEZE_WATCH=off` turns it off. Docs:
  machines.md. Tests: `freezeWatch.test.ts`.
