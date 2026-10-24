- **Half the workers compact earlier, a pilot** (w2002, lothsahn: "File the compaction pilot plus the base-context trim and noise
  fixes"). 96% of workers' cache-read tokens come from calls above 100k of context. A stable half of worker sessions (by a hash of
  the id, `worker.earlyCompactPilotPercent`) now compacts between turns from 120,000 tokens (`worker.earlyCompactAtTokens`) and
  within a turn from 150,000 (`worker.earlyCompactMidTurnTokens`, Claude Code's own autocompact through the process's
  `autoCompactWindow` setting); the rest keep 200,000 and Claude Code's default. Neither goes under 80,000. A pilot session's
  prompt ends with `## Compaction (pilot)`; `scripts/compact-compare.py` reads the two arms from the transcripts (cache reads and
  cost a call, session and request, compactions, re-reads and repeated commands after a compaction). Docs: spend.md
  ("Compacting earlier, a pilot"). Tests: `workerCompact.test.ts`, `appConfig.test.ts`.
