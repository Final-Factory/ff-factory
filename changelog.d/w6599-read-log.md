- **Worker read log** (w6599, Windows): the daemon now records which files workers open outside the work folder and not on
  its allowlist, in `<appDir>/logs/read-log-<date>.jsonl` and once a day per worker and folder in daemon.log (`read log:
  ...`). Warn only, as lothsahn chose ("Keep today's fence and add read logging only"): nothing is refused and no label or
  ACL changes. It logs paths and the reading program only. daemon.json `readLog` `off` stops it (`ops_worker
  machine_update read_log off`, `--read-log`, `-ReadLog`).
