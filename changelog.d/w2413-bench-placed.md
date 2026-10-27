- **The daemon tells the bench queue where each worker runs now** (w2413, lothsahn: "a worker's own editor ticket must
  never hold up that same worker's exclusive or timed ticket"). priorities.json gains `placed` {session: sandbox}
  (machine/benchLock.ts `writeBenchPriorities`, machine/daemon.ts `benchPriorities`). The game repo's bench_queue.py
  (FinalFactory #2715, `own_sandboxes`) lets the holder's own editor ride along by its ticket's sandbox, its checkout's
  and that placement, so a worker placed again in another sandbox, or a timed_run ticket with no sandbox, no longer
  waits behind its own `running editor` ticket. machine/benchRaise.ts `ridesAlong` mirrors it, so such a ticket is not
  marked passed and raised. Tests: `server/benchRaise.test.ts`.
