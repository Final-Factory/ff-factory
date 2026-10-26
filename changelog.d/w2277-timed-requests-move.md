- **Timed work waiting on a big computer moves to an idle small one** (w2277): a started request marked timed (not only a
  timed leg) that waits for a bench ticket of either mode on a large computer now moves, between turns, to a small or
  medium computer that becomes idle. A timed_place "here" given only because no small computer was free is withdrawn once
  one is idle, so no new exclusive ticket is granted on the big one. Work that is not timed may not take an idle small
  computer that timed work is waiting for. An unpause is acted on at once, and profiling, p99 and FPS before/after
  requests now count as timed.
