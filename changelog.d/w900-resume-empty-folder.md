- **The Dev Drive move resumes after a cut-off removal** (w900, found on lothdesktop): a sandbox folder that git no longer lists as a
  worktree (git dropped it but a held folder stayed) was read as "on a detached HEAD" and refused every resume with "nothing was moved".
  An empty one is now removed, one with leftovers is set aside as `<name>.before-dev-drive`, and the move carries on.
