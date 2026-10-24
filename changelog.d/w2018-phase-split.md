- **spend_report splits the workers' cost by phase and counts their pushes** (w2018, lothsahn: "Make the token-saving pilots
  measurable"). Each agent's context meter charges every model call to research (before the first edit), implementing (before
  the first push) or after the first push, and counts `git push`, `ff-pr push` and `gh pr create`. spend_report gains a "By
  phase" section for all workers, each machine and the top requests: dollars, shares, sessions, and pushes per session (median,
  p90). The request and session views gain one line. `scripts/worker-calls.ts` prints the same split from a computer's own
  transcripts. History before a machine's update has no phase readings. The 7-day beast baseline (60% of cost after the first
  push; median 2, p90 9 pushes a session) is in docs/spend.md, "The phase split, measured as it runs". Tests:
  `spend.test.ts`, `worker-calls.test.ts`.
