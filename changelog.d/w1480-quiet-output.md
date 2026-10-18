- **Quieter tool output for workers** (w1480, lothsahn: "pilot caveman and quieter tool output"). Workers start with the C#
  language server plugin off (`WORKER_DISABLED_PLUGINS`, passed as the process's own `--settings`): in a sandbox it cannot resolve
  the game's Unity assemblies, and on beast (2026-10-15..18) it attached 1,508 bogus "errors" (FFCore, Entity, float3 not found)
  to 28 worker sessions, which every later call read again. The worker prompt's shell rules gain one line: find the lines first and
  read only the range needed, cap searches, and print a build's, test run's or CI log's summary and failures, not the whole log
  (tool output is 46% of what a worker's later calls re-read, measured). Tests: `machineUnityMcp.test.ts`.
