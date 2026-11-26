- **ffu-slot and the fenced git start fewer processes** (w5991, for lothsahn). server/safeGit.ts skips its per-call config
  scan for subcommands that start no program a repository names (rev-parse, merge-base, symbolic-ref, show-ref,
  for-each-ref, config, worktree list and prune); the fixed keys still apply. A per-repository scan cache was rejected: the
  shared ffu clone's config is written by every slot holder. ffu-slot's own git runs no hooks except on a push (no `sh`
  start per checkout or commit), and server/ffuSlots.test.ts turns off automatic gc and maintenance in its fixtures.
  Measured on LothDesktop: that test file's git processes 861 to 715 (scans 266 to 178). w5996's review found merge-base, show-ref, for-each-ref and `rev-parse X^{commit}` lazy-fetch through a planted partial clone's core.sshCommand: they scan, and the skipped calls carry GIT_NO_LAZY_FETCH=1. Tests: `safeGit.test.ts`,
  `ffuSlots.test.ts` (w5991).
