- **Git packages a sandbox editor lacks** (w6412): when a branch's `Packages/manifest.json` names a git package that
  `Library/PackageCache` has no copy of, the start note, `unity status`, the switch's notes and the "Unity Package
  Manager Error" dialog notice now name the package, the cause and the route. The cause on Windows: a Low-integrity
  editor's Package Manager cannot fetch it, because the machine's Git dies at Low and there is no credential. The new
  daemon.json `editorGitPackages` setting has three values. `warn` is the default and only gives that note. `on` also
  fetches each missing repository into a bare mirror under `<root>/cache-medium/git-packages`, using the daemon's own git
  and credential outside the fence. The Low editor then starts with the workers' Git on its PATH and a `url.insteadOf`
  that points at the mirror, so no credential reaches the editor and no tracked file changes. `off` looks at nothing.
  Set it remotely with `ops_worker machine_update editor_git_packages off|warn|on`, which uses the daemon link or the
  installer (`--editor-git-packages`, `-EditorGitPackages`).
  In `on`, a mirror holds only one git process at a time, even when two sandboxes start on different pins of one
  repository. A mirror's config is written only when it differs from what it should be. Each pinned commit is kept by
  a `refs/ff-pin` ref. A start waits at most 3 minutes for its mirrors, and a fetch moving under 1 KB/s for a minute
  gives up. Git's error line in a note has any URL credential and token masked (the w6423 review).
