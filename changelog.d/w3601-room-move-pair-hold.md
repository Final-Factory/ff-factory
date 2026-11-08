- **A room move waits for a pair run's sandbox too** (w3601, lothsahn). When a worker's work moves to another computer because
  its own is full (or away), it no longer takes the last free sandbox a Queued pair run or timed run is held for: the pair
  starts there, and the move waits, its Queued line naming the hold.
