- **A worker waiting on its orchestrator for a step only an orchestrator can take tells that orchestrator, once** (w2870,
  lothsahn). w2833's worker reported four times "still open: the orchestrator runs the live ffbox_activity demo ... workers
  don't have those tools" and the ledger read "Merged, follow-up pending" with no alert for 2.5 h. Such a line (either
  "waiting on the orchestrator to ..." or "the orchestrator runs/sends/fetches ...", not the worker's own work, a restart, a
  pair run or the dispatcher's) now shows **Waiting on input** on "<requester>'s orchestrator", ahead of "Merged, follow-up
  pending", and the requester's orchestrator gets one `[orchestrator step]` message with the line and what to do; a
  re-report of the same wait sends nothing, a report without it ends the wait. Workers get no new tools. Docs:
  orchestrators.md ("What a request is doing now", "Waiting, Queued, Blocked"). Tests: `w2870OrchestratorStep.test.ts`,
  `orchestrators.test.ts` (w2870).
