- **Git the daemon, the agent host and Medium run in a worker's checkout runs no program the worker named** (w5541, the
  w5451 audit's item 3): every such git call goes through `server/safeGit.ts`, which forces `core.fsmonitor=false`, hooks
  off, the `cat` pager, no signing, only the https/http/ssh/file transports and no external diff or textconv, and puts a
  repository's own filter, merge, diff, credential and ssh programs back to the user's or a neutral value. A lint in
  `server/safeGit.test.ts` fails on a git spawn that skips it. Needs a portal deploy (machines update themselves after).
- **`worker.ts tools` runs registerAgents.sh from a fresh clone of final-factory-agents, not the worker-writable checkout in the
  root** (w5573, from w5542's audit), made with no global or system config; a repository-set `url.<base>.insteadOf` now
  refuses the daemon's fetch and push in that checkout (the vault token could have gone to the worker's remote), and the
  installer's `git archive` of the daemon code runs fenced too.
