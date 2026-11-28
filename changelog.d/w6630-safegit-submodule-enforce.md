- **safeGit stops git calls from running a submodule's own programs** (w6630, the enforcing step after #1538's warnings).
  Every scanned call now runs with submodule recursion off (`submodule.recurse=false`, `fetch.recurseSubmodules=false`,
  `diff.ignoreSubmodules=dirty`, `status.submoduleSummary=false`, `diff.submodule=short`), so a fetch, pull, status or diff
  in a superproject starts no child git in a submodule. What that cannot stop is refused with a message that says what to run
  instead: `git submodule`, `--recurse-submodules`, `--submodule=diff|log`, a caller's `-c` of those keys, and `git add`/`git
  rm` whose pathspec covers a submodule (leave it out with `':!<submodule>'`, or run git in the submodule itself). Since a
  superproject's status no longer shows a submodule's edits, the clean-up checks each submodule as its own repository: a
  populated submodule, a deinit'ed one's git folder under `.git/modules`, and an untracked clone inside. Tests:
  `server/safeGit.test.ts`, `server/cleanupFolders.test.ts`.
