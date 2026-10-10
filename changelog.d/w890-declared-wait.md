- **A worker's own `waiting_on_person` frees its sandbox even when it serves two requests** (w890, found live on the
  portal after the deploy: biscuit/slot3 stayed held with its worker Idle after it declared it waited on lothsahn). The
  ledger reads a worker started for one request and then sent another as working on the second only, so the first never
  read Waiting and the release rule ("every request it is the latest worker on waits") failed. The declaration now covers
  all of them (`Agents.waitOn`). Needs a portal deploy.
