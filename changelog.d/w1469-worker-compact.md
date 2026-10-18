- **Workers compact by themselves at 200,000 tokens** (w1469, lothsahn: "Build 1, 2 and 4: compact at ~200k, compact before long
  waits, trim the base"). A worker's context averaged 357k tokens a call on beast, and every call reads it all again. FF Factory
  now compacts a worker between turns once its context passes 200,000 tokens (`worker.compactAtTokens`), with Claude Code's own
  /compact and a focus that keeps the requests, people's words, branch, PRs and what is verified and left. First a pilot: 34% of
  worker sessions (`worker.compactPilotPercent`). Machines' daemons carry it (`compact` in the hello); an older daemon's workers
  are left alone. Modelled on beast's 3 days: -44% of the workers' spend. Docs: spend.md ("Workers compact"). Tests:
  `workerCompact.test.ts`, `agentHost.test.ts`, `autoCompact.test.ts`.
