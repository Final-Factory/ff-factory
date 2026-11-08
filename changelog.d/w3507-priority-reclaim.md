- **Game sandboxes go out by priority** (w3507, lothsahn). Queued game work with no room now frees a sandbox from a
  worker of strictly lower priority on a computer where a free sandbox is all it lacks: an idle holder (between turns,
  waiting on CI, a person or a near check-in, stopped) is released as any release is, its work saved on its branch, and it
  resumes there; urgent work with nothing reclaimable asks one mid-turn low or normal worker to finish at a safe point,
  push and end its turn, never interrupting it. Equal priority never takes; pair runs, timed legs, the release lane, bench
  locks, Unity batch runs, players, Live views and background jobs are never touched; a moved worker is protected 30 minutes
  after it is back. The Queued line says which sandbox was freed or why none may be, and both requests' logs say what
  happened. `server/priorityReclaim.ts`, docs/machines.md "Higher-priority work frees a sandbox".
