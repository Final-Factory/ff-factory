- **Long runs that outlive their worker's host** (w6367, warn only): a new daemon RPC route, `runs/start`, starts a
  sanctioned long run (only the nightly) outside the worker's agent host. The run is at Low integrity,
  always in a job of its own, ended after 20 hours or by `runs/stop`, and without FF_SESSION_ID. A w2625 host swap therefore no longer kills the
  night, as it did on LothDesktop on 11-26 and 11-27 (w6360). daemon.json `longRuns` (`ops_worker machine_update long_runs
  off|warn|on`) defaults to `warn`: the daemon logs what it would start and starts nothing. Turning it on is a separate,
  reviewed change.
