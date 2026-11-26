- **Six more tests pass on a loaded Windows computer** (w5915, BEAST's full runs): path-fence tests split a PATH on
  `path.delimiter` and skip the old-shims guard where the path fence is off; w5300's cached players have real-looking
  commits (a process holding base64 zeros "named" `aaaa…`); w605 stops the daemon before its host, so the daemon cannot
  report the host's death first; hostCode's stand-in host exits after its closed line (each test waited out a 10 s exit
  wait, now about 0.1 s); w5938 reads each stand-in's command line once (a PowerShell CIM query on Windows); and w2231's
  last wait, a real sandbox switch on the test machine, allows 30 s.
