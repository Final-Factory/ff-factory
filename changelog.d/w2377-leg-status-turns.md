- **A timed leg's status-only turn no longer wakes its parent (w2377):** a request Blocked on its timed leg's report
  resumes only when the leg reports a result for it (a `For <parent>:` line, a partial one too, `DONE`, or a wait on the
  parent) or turns Blocked itself. A turn that says only that its bench ticket is still queued, or "understood", leaves
  it Blocked, and a branch named after the parent is no longer read as a wait on it.
