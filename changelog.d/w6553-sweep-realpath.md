- **The session sweep no longer holds the daemon's event loop while it looks for a process using a folder** (w6553,
  after w6486). On BEAST, `planSessionSweep` held the loop for 891 s (22:06-22:21 UTC on 2026-11-27, ff-factory
  35bddd89) in synchronous realpaths. `mentions` resolved the swept folder's real path again for every running process,
  and expanded each command line's 8.3 short names with `existsSync` and `realpathSync`. The sweep now works out the
  folder's real path once, with `fs.promises.realpath`, and expands short names with `expandShortNamesAsync`. It keeps
  and lists the same folders as before.
