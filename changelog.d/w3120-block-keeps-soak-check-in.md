- **Blocking a request no longer cancels the check-in of a worker the block is not about, and a held check-in keeps that
  worker's background run** (w3120, after w2895: the dispatcher blocked the FFU fan-out on w3118, another leg's CI fix;
  decide_work block cancelled 738652d6's check-in for the end of its 24 h soak, and 2 min after the worker stopped the
  daemon's leftover sweep ended ffu-server and 246 ffu-bots, 12 h into the run). On a request with several workers,
  `decide_work block` now cancels and holds only the check-ins of the workers named in `session_ids` (a stranger is
  refused); the others keep theirs, and the reply says whose it kept. One worker alone: unchanged (w754). Every check-in a
  block holds on an open request goes to the machine's daemon as that worker's wake, so the sweep keeps what it left
  running until it is due plus the grace. Tests: `orchestrators.test.ts` and `machines.test.ts` ("w3120").
