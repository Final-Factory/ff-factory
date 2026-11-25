- **Transcripts are read-only to workers** (w5563, lothsahn: "transcripts are read-only to workers"). The host that runs a
  conversation seals Claude Code's transcript (its length and the sha256 of what the CLI appended) at each turn's end and once
  the process has exited, in `<appDir>/transcript-seals` (the portal: `<data>/transcript-seals`), where no worker writes. A
  transcript changed since its seal (an earlier line edited, cut, deleted, or lines added after its process ended) is not
  resumed: a fresh conversation starts, told why in its first message, and the ledger's transcript says which file and why.
  On macOS the fence also refuses a write to any other conversation's transcript: only the process's own `<id>.jsonl` and
  `<id>/` are writable in `<CLAUDE_CONFIG_DIR>/projects`. New conversations get their id from FF Factory (`sessionId`).
  Linux and Windows per-conversation access are follow-ups. Docs: transcript-seal.md, worker-fence.md. Tests:
  `transcriptSeal.test.ts`, `workerFence.test.ts`.
