- **A players-broker lease whose pid Windows handed to another process no longer holds the slot** (w6549, found by
  w6536 on lothdesktop/slot3-0). The broker counted a lease live while `process.kill(pid, 0)` answered, and EPERM counts as
  an answer: slot3-0's lease named pid 117496, which by then was an unrelated conhost started an hour after the lease, so
  every `players/install` there was refused. The daemon now asks for the start time of each local lease's pid (one
  Win32_Process or `ps` query per slot check) and drops a lease whose process is not its holder: for a player_slots.py lease, one whose start differs from its recorded
  `pid_created` by more than 2 s (as player_slots.py's holder_alive judges it); for any other, one that started after the
  latest of its `time`, `held` and the file's own write time. A pid
  the OS gives no start time for, or a failed query, keeps the lease as before, so nothing accepted today is refused.
