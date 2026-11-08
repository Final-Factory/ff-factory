- **A released worker gives way to a waiting pair run** (w3588, lothsahn). When a freed sandbox is the one a Queued pair
  run needs to start (its other legs have room), a worker that released it no longer takes it back for its near check-in or
  a queued message, unless its own work outranks the pair: the pair starts there instead. Its Queued line says so.
