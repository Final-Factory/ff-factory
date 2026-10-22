- **A worker's temp folder with no activity for a day loses its rebuildable caches, even while its request keeps the
  folder** (w1719, lothsahn: "delete caches after 24 hours of inactivity for that test folder"). The daemon's clean-up now
  takes, from any `tmp/ffa-<session>` whose worker is not running, which no process names and in which nothing was written
  for 24 h: player builds (the newest ones too), a Unity project's Library, Temp and obj, `node_modules`, Unity Profiler
  captures whose digest sits beside them, and `frames` folders beside their clip. Nothing git holds, and no clip, still,
  log, report, save or clone, goes; each removal is in the clean-up log with its size. On biscuit a dry run took 64.2 GB
  from 6 of its 44 worker folders.
