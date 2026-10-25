- **A request blocked on a deploy hears when the automatic deploy is held on red CI** (w2140, lothsahn; w2116 waited 2.5 h
  on "beast's update" while the deploy waited on a failed Windows tests run). The request's live state leads with
  "deploy held: master CI failed on <sha> (<workflow>)", the worker whose pull request that commit merged (or else the
  blocked worker) is resumed once to fix it, and the request's people hear it once per held commit. Docs: ops-worker.md
  ("Automatic deploys", Green CI). Tests: `autoDeploy.test.ts`, `ledgerSweep.test.ts`.
