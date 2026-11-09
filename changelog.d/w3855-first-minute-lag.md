- **The first minute after a portal restart no longer holds the event loop for seconds** (w3855, for ben: after w3843's
  deploy on 2026-11-09 the loop still stood up to 3.7 s and m5, biscuit and lothdesktop dropped). A resumed conversation's
  process now launches after the task that started it, one launch at a time (`sessions.ts` `launchResumed`): the kept-tools
  refresh and the tally rebuilt from Claude Code's transcript read the file through the thread pool and parse it in 50 ms
  slices, so one daemon's turn end fanning out to every person's orchestrator no longer reads every transcript in one task.
  Messages sent meanwhile queue in order, a stop meanwhile launches nothing, and a model chosen meanwhile is the one it
  starts on. The transcript scrubber reads and writes 1 MB chunks asynchronously (it spent 24.7 s of CPU in that minute),
  and a daemon's welcome looks up its sessions' last seqs at most 25 ms a loop turn as well as 200. The boot's own time is
  logged once as `startup:` instead of a `blocked` line. Placement is unchanged. Bench:
  `node scripts/restart-lag-bench.ts --replay 2` (its resume leg: 6 orchestrators x 40 MB went from a 1.7-3.5 s block to
  under 0.3 s on lothdesktop).
