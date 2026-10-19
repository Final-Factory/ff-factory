- **fff-health gives a freshly started portal 5 minutes before checking it** (w1537): `HEALTH_START_GRACE_SEC` goes from 120 to 300.
  After the FFBox host rebooted, nine Actions runners fetching git-lfs at once saturated its disks; the portal sat blocked on
  reads loading its 7.2 GB data folder, and fff-health restarted it at 220 s and again at 340 s (12 s after it had recovered),
  each restart starting the load again. A hang later in the portal's life is still restarted after 4 failed checks. A VM whose
  `/etc/fff/fff.conf` sets `HEALTH_START_GRACE_SEC` itself keeps its own value.
- **The orchestration worker can read and change the VM's own settings, `/etc/fff/fff.conf`** (w1537; lothsahn: "It should be
  able to touch any settings that aren't credentials or keys or secrets"): `fffctl conf` (every setting, `<redacted>` for what
  is a person's) and `fffctl conf set KEY VALUE` (one setting, its value checked, the file before kept as `fff.conf.prev`; it
  prints only that setting, old -> new, and when it takes effect, and restarts nothing). Refused: credentials, keys and
  secrets (by name, and any value that looks like a token), the deploy's code, the VM's layout and the worker's own fences.
  The health and watchdog settings apply at the next 30 s check; `NODE_MAJOR` and `BACKUP_TIME` at the next update
  (docs/ops-worker.md, "fff.conf settings"). Needs a portal deploy.
