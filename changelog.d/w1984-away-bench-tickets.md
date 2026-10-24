- **A stopped or moved worker's waiting bench tickets hold nobody back** (w1984). On LothDesktop on 2026-10-24 the
  exclusive ticket t00000982 kept waiting for w1789 after its worker 2e29f29e was stopped at about 04:10Z (a pending
  check-in kept its waiter alive), and w1789's timed run had moved to LothLaptop; newer shared tickets queued behind it.
  The portal now marks such a session `away` in each machine's `priorities.json`: stopped on purpose (every waiting
  ticket, until it is messaged again), or with a ticket in another machine's queue or a `timed_place` verdict
  "elsewhere" (its exclusive tickets only). The game repo's bench_queue.py (FinalFactory#2382) parks those tickets and
  queues them again at the back when the mark goes. `server/agents.ts` `benchAway`; tests in
  `server/orchestrators.test.ts` and `server/benchRaise.test.ts`.
