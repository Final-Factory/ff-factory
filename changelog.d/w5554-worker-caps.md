- **Every worker is capped on memory, processes and temp disk** (w5554, item 25 of the rogue-worker audit w5451; lothsahn:
  "File it: generous per-worker memory, process and temp-disk caps"). A worker's agent host and everything it starts are in a
  Windows job object (commit limit and active-process limit, no breakaway), a Linux systemd scope with MemoryMax and TasksMax
  (where the user manager delegates them, probed), or on a Mac a tree watch. On every OS, the temp folder has a hard cap.
  - The caps:
    - memory: 80% of RAM, at least 8 GiB
    - processes: 2048
    - Linux tasks: 16384
    - temp: 60 GB
  - The heaviest normal worker measured stays under them: three batch Unity builds were about 45.5 GB, a worker's tree had at
    most 38 processes, and the biggest temp folder was 36.5 GB.
  - Past a cap, the host ends the worker's tools, not its claude. The worker's next tool result says which cap it hit and what
    to do, and the request's ledger gets a line.
  - Sandbox Unity editors are not capped: they are the sandbox's, and bounded by the 3-editor limit.
  - Details: docs/worker-caps.md. Needs a daemon update on every machine.
