- **safeGit warns on git calls that recurse into submodules** (w6630, reviewed by w6648). A submodule's own config is never
  scanned, and a fetch, status, diff, `git add -A` or `git rm` in a superproject can start a child git that runs its programs
  (measured). The fence now warns, warn-only, on an explicit recursion (`git submodule`, `--recurse-submodules`,
  `--submodule=diff|log`, a caller's `-c` of the recursion keys), on `git add`/`git rm` in a repository that shows submodules,
  and on any other call there; the enforcing step comes in a later pull request. Tests: `server/safeGit.test.ts`.
