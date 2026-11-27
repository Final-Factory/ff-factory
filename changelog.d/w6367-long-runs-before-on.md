- **Long runs, before `on`** (w6367): hardening of the daemon's long-run route from review w6379. Its link checks now
  resolve Windows junctions (`fs.realpathSync.native`). `runs/stop` reaches a run only through its keeper's stdin, held by
  the daemon process that started it, never by a pid that Windows may have reused. The daemon logs each run's end with its
  exit code. `long_runs on` needs a person's go, and `off` does not end runs already live. The route stays `warn` by default.
