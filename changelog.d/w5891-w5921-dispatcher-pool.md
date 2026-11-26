- **The dispatcher follows its pool config, and a config change applies at once** (w5891, w5921): `claudeAccounts.dispatcher`
  takes `"pool:<login>"` (any token of that person's own pool with room). On a used-up token the dispatcher moves to another
  token of its configured pool before its next turn, never to another pool; with the whole pool out it waits, and the alert
  names the first reset. A change of `claudeAccounts.dispatcher` or of a pool setting restarts the dispatcher (and a
  person's orchestrator) between turns, never mid-turn. Its reserve sits on the token it runs on; its stop fires only when the
  whole pool is out.
