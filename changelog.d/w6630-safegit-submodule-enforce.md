- **safeGit stops git calls from running a submodule's own programs** (w6630, the enforcing step after #1538's warnings).
  Every scanned call now runs with submodule recursion off (`submodule.recurse=false`, `fetch.recurseSubmodules=false`,
  `diff.ignoreSubmodules=dirty`, `status.submoduleSummary=false`, `diff.submodule=short`, autostash off), so a fetch, pull,
  status or diff in a superproject starts no child git in a submodule. A submodule's own `ignore` setting (which a branch's
  .gitmodules can bring) beats that config, so `status`, `diff`, `diff-files` and `diff-index` also get
  `--ignore-submodules=dirty`, and `checkout`, `switch`, `stash apply` and `stash pop` get `--quiet`. What none of that can
  stop is refused with a message that says what to run instead: `git submodule`, `--recurse-submodules`,
  `--submodule=diff|log`, a caller's `-c` of those keys, `git add`/`rm`/`mv` whose pathspec covers a submodule (leave it out
  with `':!<submodule>'`, or run git in the submodule itself), and, in a repository with a submodule, `commit`, `stash` push
  or branch, `describe --dirty`, an autostash, a merge or pull other than plain `--ff-only` (or `merge --abort`/`--quit`), `difftool` and `mergetool`. A call whose name is an alias (the repository's, the user's or a caller's `-c alias.*`) is refused too, since the fence checks the name it is given. Since a superproject's status no longer shows a submodule's edits, the
  clean-up checks each submodule as its own repository: a populated submodule, a deinit'ed one's git folder (a linked
  worktree's too), and an untracked clone inside; what it cannot read counts as work. Tests: `server/safeGit.test.ts`,
  `server/cleanupFolders.test.ts`.
