- **safeGit forces `core.alternateRefsCommand` empty** (w6082, finding F7 of w5946's review r390): a repository whose
  `objects/info/alternates` names another ran a command its own config planted there on every fetch the daemon made in it.
  Fenced git now starts nothing there, and the fetch still works. Needs a portal deploy (machines update themselves after).
