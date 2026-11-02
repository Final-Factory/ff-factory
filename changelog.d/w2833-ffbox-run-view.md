- **FFBox's container runs, read over the tunnel** (w2833, lothsahn: "FFFactory should be able to view the logs,
  conversations, and agent run details over the tunnel upon request"). `ffbox_activity` `show: "run"` with a conversation
  `id` lists its runs; with `run` and `file` it shows one run's `stream.jsonl`, `summary.md`, `claude.log`, `ffbox.log` or
  `container.log` (the last 200 lines by default, `grep`, `regex`, `offset` for older pages), or `steps`: each tool call
  with its first line and result status, and the run's final text. `show: "conversation"` takes `chars` up to 32000 for
  each turn's full text. Read-only and redacted on FFBox (its new `run_file` query) and again here. Docs: ffbox.md,
  ffbox-connector-contract.md. Tests: `providers.test.ts` (`run:`).
