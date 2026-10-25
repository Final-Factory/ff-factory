- **Timed work follows the timing order at its start and while it waits** (w2168): start_agent and stop_agent move_to now
  refuse timed work on a busy or bigger computer while a smaller one that takes timed runs is idle, and name that one. A
  started timed leg that is between turns and waiting for an exclusive bench ticket on a large computer moves to a small
  or medium computer that becomes idle. LothLaptop stays out of placement.prefer, and that does not drop it from timed
  placement.
