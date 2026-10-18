- **Spend: the agent's own output is no longer counted as base context** (w1469, lothsahn: "It seems like most requests are
  using a high amount of base tokens. What's causing that"). The context meter took each model call's output from the SDK's
  assistant messages, which carry message_start's usage (an output of about 1); the real count comes after them in the
  stream's `message_delta`. The agent's output and thinking, read again by every later call, fell in `base`: replayed on beast's
  3 days, base read 60% that way and 28% with the real counts (the agent's output 36%). The meter now takes the count from
  `message_delta`, and a compaction's summary is `summary`, not base. Categories only: dollars and attribution do not move.
  Applies to turns after a portal deploy and the machines' daemon updates; earlier turns keep their categories. Docs:
  spend.md ("The agent's own output read as base until w1469"). Tests: `meterStream.test.ts`, `spend.test.ts`.
