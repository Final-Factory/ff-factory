- **A machine cannot relabel its own agent sessions** (w5515, finding 10 of the w5452 security audit; lothsahn: "File it:
  strip the identity fields machines send"). The portal takes only the run-state fields (`DAEMON_RUN_FIELDS`) from a
  daemon's session update instead of everything but a strip list: `requestedBy`, `lastRequestedBy`, `orchestratorRole`,
  `permissionMode`, `effort` and the other portal-owned fields stay the portal's records, for `mayAct` and the cost ledger.
  The agent's own spend (`costUsd`) is still the daemon's and is attributed by those records. A reported `account` is
  taken only when the portal handed that session the matching token. Nothing changes for normal use. Docs: machines.md.
  Tests: `machines.test.ts` (w5515).
