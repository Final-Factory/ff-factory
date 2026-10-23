- **The Dev Drive sizing rule counts what the disk really holds** (w1947, lothsahn: "Let's account for it in the sizing
  rule"). w1910's rule summed logical sizes, so a sandbox's Library counted the seed's blocks again, its worktree counted the
  clone's LFS blocks again, and the bare clone got a 10 GB checkout it does not have. Measured with cluster maps on
  LothDesktop, a sandbox now counts 30 GB (was 44): its worktree and Library less what they share with the clone and the
  seed, plus its player folders. One sandbox with one agent needs 98 GB (was 112).
