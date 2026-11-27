- **Live-run warning before a sandbox trim** (w6378): the daemon now logs a `WARNING sandbox <id>: ... while a run of its
  worker still lives there` line when a Library cache trim (and its release sweep), a pool release or a delete would hit a
  sandbox where a nightly, a unity-slot run or a batchmode Unity of its worker still runs, as on 2026-11-27 when slot2 was
  trimmed and its night's player build swept under the w6357 nightly. Warn only: nothing changes behaviour. daemon.json
  `liveRunGuard` `off` stops the look (`ops_worker machine_update live_run_guard off`, `--live-run-guard`, `-LiveRunGuard`).
