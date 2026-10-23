- **The clean-up log says why a worker folder's rebuildable caches stayed** (w1813). A low-disk pass, and a dry run, now
  writes a `kept` line for each worker temp folder whose caches it left (256 MiB or more), with their size and the check
  that kept them: its worker runs, a process names it, a recent write (how long ago and which file), too many entries to
  judge, an unreadable folder, or the guard or git holding a cache. LothDesktop's first low pass on 2026-10-23 left two big
  folders whole without a word.
