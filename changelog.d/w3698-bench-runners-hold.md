- **An exclusive bench turn keeps its paused CI runners paused until it ends** (w3698; m3, 2026-11-08: ffu listeners were
  continued at about 17:53Z and 17:58Z under w3141's ticket t00001186). Three fixes in `machine/benchRunners.ts`: a listener
  whose newest log line is a job older than `STALE_JOB_MS` is no longer paused and continued on every 5-second look (the
  after-pause check now continues only on a line written since the look); the paused listeners are continued only once
  `RELEASE_LOOKS` (3) looks in a row find no holder, so one look that misses a held ticket continues nothing; and a look
  whose process listing never came back no longer stops every later look (`STUCK_STEP_MS`). Tests: `benchRunners.test.ts`.
