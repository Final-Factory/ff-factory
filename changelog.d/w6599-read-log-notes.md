- **Worker read log, review notes** (w6599, review w6750): the daemon starts the read-log helper without `FFREADLOG_TRACE`
  whatever its own environment holds, so a leftover variable can no longer make it log paths a person's processes open
  (only the real-ETW test passes a trace). Events dropped because one gone or pending process already held its cap of
  waiting events are now counted in the helper's minute line (`overflow`) and in daemon.log.
