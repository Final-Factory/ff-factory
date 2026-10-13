- **What a stopped worker left running is ended** (w1196, w1197; Ben: "please update the fff harness to ensure everything
  is properly cleaned up so we arent wasting system resources on our machines after work is done"). On biscuit two headless
  game players of closed requests ran 27 h and 34 h on about 6 cores beside 17 old Xvfb displays. The machine daemon now
  reads whose every process is from its own environment (`FF_SESSION_ID`; Linux `/proc`, a Mac's `ps -E`, Windows' PEB),
  the player slot lease or a worker's temp-folder path, and ends what a stopped worker left: 2 min after its process stops
  when its work is over, 10 min when a request still waits for it, never before a pending check-in plus 10 min; a game player
  nobody owns 10 min after first seen. Never a live worker's process, an interactive editor, the main clone or another
  machine's. Each end is logged and told to the orchestrators; `list_sandboxes` and the dashboard show every player's owner
  and age. Workers get `ff-leftovers list|end` and a brief rule to end what they started before DONE. Also fixed: on a Mac
  and Linux the batch-build reaper (w791) never saw a build twice (its start time moved by up to a second between looks),
  so it ended none there. Needs a portal deploy; the daemons update after it. Docs: self-recovery.md. Tests:
  `leftovers.test.ts`.
