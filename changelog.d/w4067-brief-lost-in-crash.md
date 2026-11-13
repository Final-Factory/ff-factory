- A message sent to a worker while its turn runs, which the crash of that turn's Claude Code left unread, is sent again in a
  new process instead of dropped after a minute; and a worker whose turn ends without naming a request it was sent and never
  reported on is resumed on it, then the dispatcher told NOT STARTED (w4067: w4048's brief sat 3 h behind a crashed turn).
