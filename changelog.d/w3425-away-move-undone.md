- **An away move that never happened no longer parks its worker's bench tickets** (w3425). `movedAway` (w1984) was set
  when a move started and never cleared when it did not complete: on 2026-11-07 worker 416bdb60's move off beast was cut
  by a portal restart, the worker ran on, and bench_queue.py parked every exclusive ticket it took on beast for over an
  hour. `Agents.awayMoveUndone` now clears the mark when the worker runs on its old machine with its requests still on it
  (its daemon reports it running) or asks `timed_place` there. Test in `server/orchestrators.test.ts`.
