- **A person's orchestrator fills its context more slowly** (w1866, lothsahn: "You have been compacting every few messages,
  going from ~30k to over 100k quickly."). Measured on lothsahn's orchestrator (`portal_logs coordinator_context`): a
  `list_work` list was 8,400 tokens a call and 15% of what a cycle added, and every `[worker update]` repeated the same
  relay paragraph. Now a person's orchestrator's `list_work` list leaves out the cost and placement notes and the workers
  that are gone, and cuts the why and latest word at 120 characters (`list_work` with id still shows it all); the relay
  paragraph under every worker's report is gone (its orchestrator's brief already says the same); and `list_timers` lists an ended timer with its
  note for a day, then only counts it.
