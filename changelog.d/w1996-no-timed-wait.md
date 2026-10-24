- **A worker that waits on m5 for timed work is re-placed at once** (w1996). A turn that ends with a "still open" line
  waiting on a computer that takes no timed runs (m5) for timed work (w1789: "waiting for a sandbox on m5 for the timed
  runs") is answered right away: that computer takes none, here is "Next timed work"'s order, smallest first, call
  `timed_place` now. The request's log records it. Once per worker, request and computer.
