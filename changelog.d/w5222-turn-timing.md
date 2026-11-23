- **Where an agent's turn spent its time** (w5222, lothsahn: "Are the tool calls slow or your model calls slow?").
  A worker's `agent_transcript` takes `since`/`until` (a window of at most 24 h, each event with its time) and
  `timing: true`, which splits each whole turn in the window into model steps, every tool call and a person's mid-turn
  message waiting for an answer, with medians and worst cases. The window is found by byte offset, so a gigabyte
  coordinator transcript costs a few reads. Docs: orchestrators.md ("Turn timing"). Tests: `turnTiming.test.ts`.
