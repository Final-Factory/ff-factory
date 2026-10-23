- **What fills a coordinator's context, readable by any worker** (w1866, lothsahn: "Can you figure out what is growing your
  context so quickly and a way to have that use less tokens?"). `portal_logs {source: "coordinator_context"}` reads the
  dispatcher's and each person's orchestrator's own Claude Code transcripts on the portal and answers counts only: per
  compaction cycle the start size and what it held (summary, re-attached files, instructions, the rest), the tokens each
  tool, kind of harness message and the coordinator's own output added, and which kinds of turn added them.
  `server/contextGrowth.ts`; docs/portal-logs.md.
