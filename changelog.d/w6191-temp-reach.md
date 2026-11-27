- **A stopped auto-compactor arms no retry** (w6191): `stop()` and then the sessions' `stopAll()` failed the compaction in
  flight, whose retry restarted the session 30 ms later and wrote its transcript into a folder the test had just removed
  (ENOENT in autoCompact's teardown on BEAST). The w1538 and w1749 tests stop their own compactors before setup's.
- **w1664's fake FFBox lets the upload window fill before it answers** (w6191): on a loaded computer it answered the first
  put alone, so the test saw 4 puts in flight where the window holds 8.
