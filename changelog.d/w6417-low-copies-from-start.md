- **A Windows daemon has its Low node copy from its start again, not half an hour later** (w6417, found by w6389 on
  LothDesktop). The daemon made its Low copies (LowCopies) only at the end of the start's labelling, and with the shared
  lock on, LothDesktop's labelling of the shared-lock folders ran from 13:55 to past 14:25 UTC (its log: `kept
  V:\ffw\cache\npm Medium` 14:06:53, `players` 14:09:07, `seed` 14:25:18). Until then every Low copy asked for answered
  none, with no line of its own: the players broker refused every worker-built player ("no Low node copy to copy with")
  and the slot caches' uv, npm and upm clones failed at each 10-minute pass. Now the copies are made the first time one is
  asked for (`lowCopiesNow`, `lowCopiesWanted`), still one LowCopies per daemon run that never takes over an earlier run's
  copy, and checked the same way (tools/low Medium, else swept before every run). A worker's files are still never copied
  with the daemon's rights. Tests: `lowIntegrity.test.ts` (the restart and node-reinstall case, and a guard that LowCopies
  is made only in `lowCopiesNow`).
