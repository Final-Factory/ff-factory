- **The portal deploys itself** (w1634, lothsahn: "Can we automatically deploy the portal on updates instead of waiting for
  confirmation?"). A commit merged into ff-factory's `main` goes live once its CI is green (its push runs and the merged
  pull request's runs) and `main` has had no new merge for 15 minutes, or 60 minutes after the first undeployed commit,
  through the deploy path `fffctl update` uses (build, drain, restart, verify, roll back). It waits while a coordinator
  turn (an orchestrator, the dispatcher, the ops worker), a release build or another update is under way, and its drain
  waits for coordinator turns too. Each person whose pull request went out hears of it in one `[portal deploy]` line. Off
  with `set_app_config autoDeploy.enabled false`; a deploy by hand still works. Recorded in `data/auto-deploy.json`
  (`portal_logs` source `auto_deploy`). `fff-update` builds the commit named in `update.wanted` (`ref`, only one on
  `origin/main`) and records a failed build in `update.result.json`. Docs: ops-worker.md "Automatic deploys". Tests:
  `autoDeploy.test.ts`, `restart.test.ts`, `appConfig.test.ts`.
