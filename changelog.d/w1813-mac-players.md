- **The clean-up finds a Mac player in an urgent release's folder** (w1813). Its builds and caches are now looked for six
  levels into a worker's temp folder, not five, so `urgent-<v>/workers/osx-<edition>/release/player/finalfactory.app` (about
  1.9 GB each) goes like the Windows and Linux players beside it. LothDesktop's ffa-409f9363 had lost those to the clean-up
  and kept both Mac ones, and the log never named them.
