- **The Dev Drive move finds a sandbox's worktree whatever the spelling of its path** (w1038, w910's finding): since #320 the move treated a sandbox folder
  as a leftover unless git's `worktree list` spelled it exactly as the pool's record did. On Windows git prints the long real path and the record may
  have a short name (RUNNER~1), a junction or another case, so two of the move's tests failed there. Paths are now compared by real path; the test uses an alias.
