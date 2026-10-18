- **Terse prose between tool calls, a pilot** (w1480, lothsahn: "File it: measure the history, then pilot caveman and quieter tool
  output"). Half of worker sessions (`worker.terseProsePilotPercent`, default 50, drawn apart from the compaction pilot) get a short
  rule: nothing between routine tool calls, one short line when something must be said; reports, PR descriptions, commits and
  DONE lines stay plain English. Measured on beast (2026-10-15..18): text between tool calls is 0.8% of what later calls re-read,
  tool results 46% and tool-call input 18%; the pilot measures what the rule does to the rest of the output. Caveman itself
  (Apache-2.0) is not vendored: its own numbers give -3% of output against a plain "Answer concisely.". Docs: spend.md ("What
  fills a worker's history"). Tests: `terseProse.test.ts`.
