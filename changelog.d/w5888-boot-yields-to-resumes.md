- **After a portal restart the boot's own chores wait for the resumed orchestrators** (w5888, for lothsahn: "look at
  speeding up portal deployment for updates so it goes faster"; orchestrators did not answer for 2-5 minutes after each
  update). Measured on the 2026-11-26 03:20 UTC deploy: the server was down 18 s, but the dispatcher's first turn took
  231 s and lothsahn's orchestrator's 308 s, its launch spending about 51 s checking its transcript's seal, 74 s
  refreshing its kept tools and 70 s more before its first step, while the main thread sat at 58-60 s of CPU a minute
  (the startup scrub of every Claude Code transcript took about 52 s of it) and the search index's thread held the
  other vCPU for 65 s. Now the scrub's full pass over the bytes already on disk (`CliScrubber.start({ backScanAfter })`)
  and the search index wait until every resumed process has answered (`resumesAnswered` in `server/sessions.ts`), from
  30 s after the start and never more than 5 min; what is written meanwhile is still masked as it comes, from each
  file's size at the start. Each resume logs one `resume <id> (...): answered N s after it was asked (...)` line with
  the time of each step and the transcript's size, and the start logs when the put-off chores began.
