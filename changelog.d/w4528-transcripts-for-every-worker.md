- **Every worker reads the transcripts, no grant needed** (w4528, lothsahn: "Workers should be able to read each other's
  transcripts automatically"). `search_transcripts` and `agent_transcript` answer any worker, read-only and masked as
  before; the `transcript_read` flag on `request_work` and `update_work` (w4497) is retired, with the `transcriptRead`
  field. A worker whose request quotes players' text (a Discord or FFBox intake request, `source.untrusted`) is refused,
  so a player's words cannot carry other agents' transcripts out through its thread or PR; its brief and the refusal say
  so. The worker's brief now says plainly which it is. Applies to workers on a machine after its daemon updates. Docs:
  orchestrators.md ("Workers read the ledger"). Tests: `orchestrators.test.ts` ("w4528").
