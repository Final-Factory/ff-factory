- **Workers' effort is a setting** (w2000, lothsahn: "Please file a change to downgrade the workers to medium effort
  opus"). `set_app_config worker.effort` takes `low`, `medium`, `high` or `max` (null: back to `high`), applies to every
  worker started after it with no restart, and is the default a `start_agent` without an `effort` gets. It reaches the
  session as the CLI's `--effort` flag, which beats the game repo's `.claude/settings.json` `modelSettings`; machine
  daemons add none of their own. Docs: orchestrators.md ("A worker's effort"). Tests: `appConfig.test.ts`.
