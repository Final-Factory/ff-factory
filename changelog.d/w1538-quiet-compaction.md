- **Orchestrators compact after 2 quiet minutes, and at once from 100,000 tokens** (w1538, lothsahn: "compact when it's
  above 80k and there have been no messages in 2 minutes? That way you're less likely to compact when we're trying to send
  a message? You should compact at 100k no matter what."). Under `orchestrator.compactHardAtTokens` (default 100,000), an
  orchestrator due for an automatic compaction now waits until its conversation has had no turn for
  `orchestrator.compactIdleSeconds` (default 120); any message, a person's or the harness's, starts the wait again. From
  the hard threshold on it compacts at the turn's end, as before. A hard threshold at or under `compactAtTokens` (or 0),
  or 0 seconds, keeps the old behaviour. Both are set live with `set_app_config`. The dispatcher takes the same wait;
  workers do not. The wait is the compactor's own timer, measured from the saved end of the last turn, so a portal restart
  loses nothing. Docs: orchestrators.md ("Automatic compaction"). Tests: `autoCompact.test.ts`, `appConfig.test.ts`.
