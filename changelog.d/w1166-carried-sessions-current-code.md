- **A worker carried over by an update restarts on the new code before its next turn** (w1166; Ben: "find out why
  game-repo workers kept opening PRs into develop after develop was retired, and fix it"). An agent host keeps the guard
  and system prompt it started with across daemon updates, which adopt it: after ba015be (#359) rolled out at
  21:30-21:37 UTC on 2026-10-12, workers started on 5b129b4 kept "develop is the integration branch" and the guard that
  allowed it, and opened game PRs #1579-#1582 into develop until 22:43; #1579 merged there at 23:20. The portal now
  records the daemon commit each worker process started on (`SessionInfo.ranOn`); a live, idle worker whose machine runs
  another commit is stopped before its next message and that message starts a new process on the current code, in the
  same conversation (as an account move, w1076; never mid-turn or while a background task runs). The new process's first
  message opens with an `[updated]` line saying its prompt and guard are the current ones and win over what it read
  earlier. The guard also refuses `gh pr merge` of a game PR based on the retired develop (it reads the PR's base with
  `gh pr view`) and the API's ways to open, retarget or merge one there (`gh api .../pulls -f base=develop`,
  `.../pulls/<n>/merge`). Docs: machines.md ("Agents outlive their daemon"). Tests: `guard.test.ts`,
  `orchestrators.test.ts` (w1166).
