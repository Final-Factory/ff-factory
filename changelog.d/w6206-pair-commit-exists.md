- **A pair run's commit must exist in the game repo** (w6206, for lothsahn; found when w6187's pair run was filed with a
  mistyped full sha whose first 10 characters matched the real head of PR #4382). `request_pair` and `start_agent` ask
  GitHub for the commit (`server/gameDataDir.ts` `gameCommitAt`). An unknown sha is refused, and the refusal names it and,
  when one is found, the real commit it looks like and the branches that commit heads. A real full or short sha passes. A
  failed GitHub read places the run with a WARNING that says the commit was not checked and why; a 404 counts as a failed
  read (the token cannot see the repo), only a 422 "No commit found" as a missing commit (review w6289). A short sha GitHub
  cannot resolve is said to match no single commit, and the refusal asks for the full sha. Tests:
  `gameCommit.test.ts`, `orchestratorsPairs.test.ts` (w6206). Docs: `docs/orchestrators.md`.
