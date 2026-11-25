- **Linux workers can be kept to their own transcript** (w5702, the Linux half of w5563; lothsahn's rogue-worker audit item
  34: "transcripts are read-only to workers"). Behind a switch, off by default: `ops_worker` `machine_update`
  `transcript_lock on` (daemon.json `transcriptLock`) moves `<root>/claude/projects` to `<root>/transcripts` behind a link,
  outside the write lock, and gives each locked claude Landlock rules for its own conversation's `<id>.jsonl` and `<id>/`
  only; writing, planting, renaming or deleting another conversation's transcript is refused. New conversations, resumes
  and `/compact` run normally (measured on biscuit with Claude Code 2.1.299). `transcript_lock off` (or `worker_fence off`)
  is the remote recovery. Switching on never cuts off a worker already running: the move waits until no sandbox agent
  locked without the transcripts folder runs (w5718's review). Docs: transcript-seal.md, worker-fence.md. Tests:
  `transcriptLock.test.ts`.
