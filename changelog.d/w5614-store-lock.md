- **The main clone can be made read-only to sandbox workers** (w5614, stage 1 of w5544). It is behind a switch, off by
  default: `ops_worker` `machine_update` `store_lock`, with values `warn` or `on` (daemon.json `storeLock`).
  - `warn` refuses nothing. It logs every write into the clone's git folder that the daemon did not make.
  - `on` applies only once every sandbox is a slot repo. While it holds:
    - the macOS and Linux worker fences leave `repo` out of what workers write;
    - on Windows the clone's git folder is labelled Medium;
    - new sandboxes are slot repos.
  - Way back: `store_lock off` (docs/machines.md, "Slot repos").
