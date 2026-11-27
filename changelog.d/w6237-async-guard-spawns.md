- **The guard's git, gh and python never hold the portal's event loop** (w6237): the shell guard, which the portal runs on
  every shell command of every agent, ran `git remote -v`, `git log` (a push's emails), `gh pr view` (a merge's base and
  URL), `gh api` (a rerun's jobs, annotations and log), the repo-visibility `gh api`/`curl`, the trusted checkout's
  clone and fetch, and the 2-minute `pr_evidence.py` check with `execFileSync`/`spawnSync` on the loop. They now run on the
  probe thread of w6234 (`runOffThread`, and `gitOffThread` in `server/safeGit.ts` for the fenced git), and
  `checkShellAsync` waits for their answers while `checkShell` itself stays synchronous. `server/transcriptLabels.ts`'s
  icacls runs only in the machine daemon, not in the portal, and is unchanged. Needs a portal deploy (and each machine
  daemon's update for its own agent host).
