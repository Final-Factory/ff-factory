- **Max events go in a folder workers can't write** (w5552, lothsahn: "File it: Max events go in a folder workers can't
  write"). The portal marks intake threads replied or closed from the Max events file, and on a worker root it sat in
  `<root>/max`, which fenced workers could write, so a forged line could quietly drop a player's report. The daemon's
  file is now `<daemon>/max/max-events.jsonl` (whatever `daemon.json` names), which Landlock, Seatbelt and the Windows
  Medium label all keep read-only; the old `<root>/max` file and the legacy one are no longer read. Sandbox agents get no
  `FF_MAX_EVENTS` (the daemon strips it, and the portal no longer sets it for its own host's sandboxes); they post as Max
  with `post_as_max`, which the portal records with the calling session as before. At start the daemon checks each fence
  with a shell inside it and logs `max events: <fence> refuses a fenced worker's write ... (checked)`, or a WARNING.
  Applies at each daemon's next update. Docs: max.md, worker-root.md. Tests: `maxEventsFence.test.ts`,
  `writeLock.test.ts`, `worker-install.test.ts`, `driveRoot.test.ts`.
