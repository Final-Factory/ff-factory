- A PR conflict or red-CI notice now goes to the request that owns the PR (its `Request:` line, the ledger, or its branch)
  and that request's worker, not to the planner its `Part of:` line names; the planner hears only when the owner is closed
  or has no worker. When several requests' gates on one PR would clear at once, only one is woken and the log says which
  and why; the others wait for the PR to merge (w5845).
