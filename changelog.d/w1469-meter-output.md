- **Spend: the agent's own output is no longer counted as base context** (w1469, lothsahn: "It seems like most requests are
  using a high amount of base tokens. What's causing that"). The context meter took each model call's output from the SDK's
  assistant messages, which carry message_start's usage (an output of about 1); the real count comes after them in the
  stream's `message_delta`. The agent's output and thinking, read again by every later call, fell in `base`: replayed on beast's
  3 days, base read 60% that way and 28% with the real counts (the agent's output 36%). The meter now takes the count from
  `message_delta`, and a compaction's summary is `summary`, not base. Categories only: dollars and attribution do not move.
  Applies to turns after a portal deploy and the machines' daemon updates; earlier turns keep their categories. Docs:
  spend.md ("The agent's own output read as base until w1469"). Tests: `meterStream.test.ts`, `spend.test.ts`.
- **Spend: the base context is measured, not "whatever is unexplained"** (w1469). The first call of each agent process gives the
  base (its context less the brief); later calls read it first, then the history. A cold cache (a pause of over an hour) wrote the
  whole history again, and all of it used to count as base. It is now charged to what it rewrote. What the meter cannot itemise
  (reminders and hook output the stream never shows, the estimate's error) is a new category, `unitemised`. On beast's 3 days the
  base is 12% ($144), the same as `spend-claude.ts`'s independent measure.
