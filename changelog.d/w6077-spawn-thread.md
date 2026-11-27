- **The daemon starts programs from a thread of its own, not its event loop** (w6077). Node's `execFile` waits for a program's
  output without blocking, but starting the program (CreateProcess on Windows) runs on the calling thread. On BEAST, on
  2026-11-26 12:25-13:59 UTC, that start alone held the daemon's loop up to 35.5 s (`timer strayLowServers`, one PowerShell)
  and 8.9 s (`timer refreshMcpScopes`, one process listing), in 62 of 117 "event loop: blocked" lines. Every `run()` in the
  daemon and its compiler-server look now start the program from `server/spawnThread.ts`, with the same results; starting 20
  PowerShells at once held the loop 2.9 s directly and 48-94 ms from the thread (BEAST, measured once). A thread that dies
  answers its programs code -1 and the next program gets a new one; after 3 deaths in a minute programs start on the loop
  again, as before, and `FF_SPAWN_THREAD=off` in daemon.json's `env` does the same. The portal is unchanged.
- **A daemon block that LoopWatch can only name by "last ran" now gets the functions that held the loop** (w6077): the daemon
  runs the portal's stall profiler (V8's sampling profiler, server/stallProfile.ts) for blocks of 5 s or more, with
  "stall profile:" lines in daemon.log and the newest few profiles in `<daemon folder>/profiles`. `FF_STALL_PROFILE=off`
  turns it off. Needs a daemon update on each machine.
