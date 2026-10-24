- **Workers no longer get the `<total_tokens>` countdown after every tool result** (w2002, lothsahn: "File the compaction pilot
  plus the base-context trim and noise fixes"). Claude Code adds "`<total_tokens>N tokens left</total_tokens>`" after each tool
  result. It counts down from a fixed 15,000,000, which is not a worker's budget, and every later call reads it again: about 0.9%
  of what beast's workers read over 2026-10-17..24 (measured: the reminders since the last compaction at each call, at 2.6
  characters a token). Workers start with `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`, the switch Claude Code 2.1.284 reads first;
  on a probe session there the reminder is gone. Docs: worker-base.md. Tests: `machineUnityMcp.test.ts`.
