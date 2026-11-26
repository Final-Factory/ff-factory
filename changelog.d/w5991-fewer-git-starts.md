- **ffu-slot and the fenced git start fewer processes** (w5991, for lothsahn). server/safeGit.ts skips its per-call config
  scan for subcommands that start no program a repository names (rev-parse, merge-base, symbolic-ref, show-ref,
  for-each-ref, config, worktree list and prune); the fixed keys still apply. A per-repository scan cache was rejected: the
  shared ffu clone's config is written by every slot holder. ffu-slot's own git runs no hooks except on a push (no `sh`
  start per checkout or commit), and server/ffuSlots.test.ts turns off automatic gc and maintenance in its fixtures.
  Measured on LothDesktop: that test file's git processes 861 to 706, 88.7 s to 55.8 s. Tests: `safeGit.test.ts`,
  `ffuSlots.test.ts` (w5991).
