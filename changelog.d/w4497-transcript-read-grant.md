- **A worker on a transcript analysis reads every transcript** (w4497, lothsahn: "Workers can't call search_transcripts or
  agent_transcript, so a request that asks a worker to analyse transcripts can't be done"). A person's orchestrator sets
  `transcript_read` on its own request (`request_work transcript_read: true`, or `update_work {id, transcript_read: true}`;
  never on an intake request), like `ledger_read` and `spend_read`; while it is open or stalled, its workers may call
  `search_transcripts` over every agent (with `since`/`until` for a time window) and `agent_transcript` on any session,
  read-only, with secrets masked as now. Without it a worker's call is refused with what to ask for. The worker's brief
  says which grants it has. Applies to workers on a machine after its daemon updates. Docs: orchestrators.md ("Workers read
  the ledger"). Tests: `orchestrators.test.ts` ("w4497").
