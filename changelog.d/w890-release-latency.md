- **A worker waiting on a deploy or a person frees its sandbox on the pass after the stop, not two minutes later** (w890,
  measured live on the portal log: stopped 19:29:40Z, released 19:31:40Z, on several real workers alike). The stop writes a
  transcript line that moved the worker's last activity past the sandbox's git state, so the release waited for the daemon's
  next 2-minute git read. The stop now records the last real work (`releaseDue.workedAt`) and the git state is judged
  against that. Needs a portal deploy.
