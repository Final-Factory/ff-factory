- **GitHub's rate limit no longer clears CI waits, and one worker can no longer spend the shared token** (w3758, lothsahn).
  On 2026-11-08 the shared lothsahn token ran out from 23:20Z to 00:02Z, and the blocker watch cleared 10 CI waits as
  "unreadable" (ffu#471..#519, FinalFactory#3469 and #3470). A rate limit, even behind GraphQL's "Resource not accessible",
  now pauses a wait instead: it stays Blocked and its request's log says when reads pause and resume. The watch's CI reads
  are conditional (ETag; a 304 is free), a refused rollup is remembered for an hour, and the watch reads every 10 minutes
  while fewer than 500 calls are left: a blocked ci gate costs 0 REST calls a read once warm, down from about 1.5 (measured).
  The server log counts the portal's gh calls by caller every 15 minutes. A worker with a vault GitHub token is held from
  GitHub commands below 750 calls left (ff-pr and merges still run) and told when one command spent 300 or more.
  Docs: orchestrators.md (blocker watch). Tests: ghBudget.test.ts, ghSpendHook.test.ts, orchestrators.test.ts (w3758).
