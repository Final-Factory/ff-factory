- **Workers may delete remote feature branches; master, main and release branches stay refused** (w6815, lothsahn: "It
  should block deleting master or a release branch, but not feature branches"). The sandbox guard now lets
  `git push origin --delete <branch>`, `git push origin :<branch>` and `gh api -X DELETE
  repos/<owner>/<repo>/git/refs/heads/<branch>` through for a feature branch on any repo, and refuses master, main,
  develop, pre-1.0, Steam branch names, `release/*`, `release-*`, `urgent/*`, `hotfix/*`, `ffbox/release-*`, `ci/*`,
  version lines and safety copies (`backup/`, `rescue/`, ...), read from one list, `server/protectedBranches.ts`, plus
  tags and unclear names. Each delete let through is logged with session, sandbox, repo, branch and sha. Force pushes,
  other ref rewrites and pushes to master are refused as before; `gh api --method=DELETE` and `-XDELETE` on the other
  ref endpoints, which the guard used to read as no method, are now refused too. A plain name is deleted only when
  `git ls-remote` shows it is a branch on the remote and not a tag (`refs/heads/<branch>` needs no read); git's short
  ref names (`heads/main`, `tags/v1`) and abbreviated options (`--dele`, `--mirr`, `--forc`) are read as git reads them;
  `-c remote.<r>.push=`, the GraphQL ref mutations and `gh release delete --cleanup-tag` are refused. Docs: worker-fence.md ("Remote branch
  deletes"), README, ops-worker.md. Tests: `branchDelete.test.ts`.
