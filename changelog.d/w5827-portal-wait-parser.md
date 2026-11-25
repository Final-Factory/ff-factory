- **A worker's "still open" line that names the ff-factory repo or one of its PRs no longer blocks its request on a portal
  deploy** (w5827). w5786 was held three times on a deploy it was not waiting for: its line "waiting on the independent
  review of ff-factory PR #1258 …" read as a wait on FF Factory. `portalWaitIn` now needs the wait to say a deploy or an
  update ("the portal deploy", "#742 to deploy", "after the daemon update"), or to wait on FF Factory or the portal itself
  ("blocked on FF Factory letting …").
