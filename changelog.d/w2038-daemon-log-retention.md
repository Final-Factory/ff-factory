- **A daemon restart no longer erases its log** (w2038, lothsahn: "a daemon restart never erases recent evidence").
  Each run's `daemon.log` is kept as `daemon.log.<UTC stamp>` beside the live one (Windows: the supervisor, before every
  start; macOS and Linux: rolled past 20 MB), older ones gzipped, kept 14 days and at least the newest 20, and the logs
  folder capped at 200 MB, oldest first. An old `daemon.log.prev` is adopted at start. Windows machines get the new
  supervisor at their next deploy; until then the daemon's adoption of `.prev` at each start keeps every run that got
  that far. Docs: machines.md ("The daemon's logs"), worker-root.md, portal-logs.md. Tests: `logRetention.test.ts`.
