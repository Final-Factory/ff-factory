- **A pending Dev Drive grow no longer waits for an idle agent host** (w5906, lothsahn: "An agent host pid was blocking the
  grow.  Please file a fix so that doesn't happen again"). An agent between turns with no tool running, no pending check-in
  and no timed run of its own no longer holds the grow: once no editor, busy CI runner or other agent is in the way, the
  host guard stops its host through the daemon's stop op and grows in the same look (about 30 s after the turn ended); the
  worker resumes at its next message. "Dev Drive: grow pending" names each holder with its reason and is said again when
  that changes (the daemon log at most every 2 min, the portal's report every 15). docs/worker-install.md, "Growing the drive".
