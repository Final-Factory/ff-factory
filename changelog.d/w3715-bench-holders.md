- **A worker holding a bench ticket always goes on, and idle work can no longer keep one** (w3715; lothsahn: "make sure
  stuff holding locks can continue doing stuff"). A worker whose own work holds a bench ticket gets its messages, bench
  warnings and wake through a placement hold, a build or play hold, its machine's agent cap and its pool's usage limit (not
  a pause, which ends its processes). A ticket held while its worker has no turn and no background task running is nudged
  after 2 minutes and revoked 10 minutes later (the daemon's new `bench_revoke`: bench_queue.py's own revoke, then the
  helper's tree after 90 s). An idle holder's wake_me fires when its last ticket goes, and a stopped worker's processes
  that hold a ticket end 2 minutes after it stopped instead of waiting for its check-in. On LothDesktop on 2026-11-08 a
  probe left behind by w3536's worker held the exclusive lock for about an hour this way.
