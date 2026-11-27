- **Six more tests pass on a loaded Windows computer** (w5915, BEAST's full runs): path-fence tests split a PATH on
  `path.delimiter` and skip the old-shims guard where the path fence is off; w5300's cached players have real-looking
  commits (a process holding base64 zeros "named" `aaaa…`); w605 stops the daemon before its host, so the daemon cannot
  report the host's death first; hostCode's stand-in host exits after its closed line (each test waited out a 10 s exit
  wait, now about 0.1 s); w5938 reads each stand-in's command line once (a PowerShell CIM query on Windows); and w2231's
  last wait, a real sandbox switch on the test machine, allows 30 s.
- **w890's test holds the ledger's status question** (w5915): 3 s after w1's worker ended its turn, the question gave
  it a new turn on a loaded machine, and w3's start beside it was refused as busy (3 of 6 runs at once on BEAST).
- trustedBench w5572 waits for the bench helper to exit before removing its folder: on Windows its open lock file made the removal EPERM.
