- **The game repo's `develop` is retired: `master` is its one trunk** (w1137; Ben: "i want to get off develop as a branch
  and do everything off master. i've started using feature toggles so we dont need develop anymore", Lothsahn: "Let's
  just have steam development branch track master and have pre-release and default be manual tags. Then close the
  develop branch in github. Agree?", Ben: "Yup"). Workers branch from `origin/master`, merge it into their branch (never
  rebase a pushed one), open a PR into master (`gh pr create --base master`) and merge it on green CI (`gh pr merge <n>
  --merge`); unfinished work goes in behind a feature toggle, and a branch that started from develop is merged with
  master and its PR retargeted. The push guard now allows `gh pr create|edit --base master` on the game repo, keeps
  refusing every push to its master/main, and refuses a push to its `develop` (any refspec spelling) and a PR into it,
  saying develop is retired. The default base (`defaultBase`, `switch_branch` and `create_sandbox` create-from, the
  orchestrators' base clone, the VM's `BASE_BRANCH`) is `origin/master`; the worker, dispatcher, intake, nightly and
  FFBox briefs say master, and a version bump merged into master is the release that sets Steam `development` live
  (nothing sets pre-release or the default branch: Ben or Lothsahn move those by hand). Needs a portal deploy and the
  live `defaultBase` and `BASE_BRANCH` changed by hand (PR description, "Deploy notes"). Docs: README.md, ffbox.md,
  ffbox-integration.md, ffbox-connector-contract.md, intake.md, machines.md, orchestrators.md, standing-agents.md.
  Tests: `guard.test.ts`, `evidenceRules.test.ts`, `orchestratorMemory.test.ts`, `intakeFlow.test.ts`,
  `nightlyRules.test.ts`.
