- **A sandbox's first git status after a release trim no longer times out** (w6432, lothsahn: frantic w6431's start in
  lothdesktop/slot1 failed with a bare "git status failed: Command failed"). `git lfs dedup` (w1576) gave every LFS file a new
  modification time, so the next `git status` re-hashed all 8.5 GB of them and was killed at 120 s. The trim now puts the
  times back (200 of 200 files stale before, 0 after; the first status 17.2 s for 400 MB before, 57 ms after, measured on
  lothdesktop), a sandbox's status gets 10 minutes, and a git killed by its timeout says "timed out after N s". A worktree's
  `index.lock` left untouched for an hour by a git that died mid-write is removed before FF Factory saves or switches the
  sandbox (lothdesktop/slot4's stopped every save of a reclaim for frantic work, w6150 removed it by hand). Tests:
  `staleGitLock.test.ts`, `machineSandboxesTrim.test.ts`.
