- **`fffctl conf` reaches the orchestrators' quiet-compaction settings** (w1538, lothsahn: "Those two new settings should be
  something the new setting tool can change"). `fffctl conf get|set orchestrator.compactIdleSeconds` and
  `orchestrator.compactHardAtTokens`, the orchestration worker's included, go to config.json through set_app_config's
  own check (`server/appConfigCli.ts`, run as the portal's account). They are not copied into fff.conf: config.json stays
  their one source. The command prints one line, old -> new, keeps `config.json.prev`, refuses every other config.json key
  without echoing its value, and the change takes effect at the portal's next start. Docs: ops-worker.md ("The portal's own
  settings (w1538)"). Tests: `appConfigCli.test.ts` (fffctl end to end on Linux), `fff-ops.test.sh`,
  `opsFffctlForms.test.ts`.
