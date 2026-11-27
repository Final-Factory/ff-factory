- **A page reconnecting after a portal restart keeps its sessions; slow state builds are named** (w6382, lothsahn; after
  w6336). Each run saves every session's change counter and a content key to `session-revs.json` and takes a page's token
  of the last run up to the point that run saved, so a restart no longer resends all ~988 sessions (2.4 MB) to each page.
  The `page socket open` line times each phase of the build (`build 711ms [room 187, accounts 166, …]`), and a build of
  300 ms or more gets a `stall profile: state build of … ms` line of the functions in it, from the running profiler.
