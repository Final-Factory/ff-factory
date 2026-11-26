- **Medium agents' own temp folders, made ready to switch on** (w5869, from w5871's review of PR #1289).
  `Daemon.sessionTemp` gives a session its `tmp-medium` folder only when that folder exists and the session is not a sandbox one,
  so a Medium agent started before `mediumAgentFolders` went on keeps its real folder for `timed_run`, `publish_attachment` and
  the sweeper (F1). The age-based clean-up rules and the clean-up facts cover `<root>/tmp-medium` too (F2). Folders a fence opens
  whole (`workerIntegrityAllow`, `writeLockExtra`, the transcripts folder while `transcriptLock` is off) count as worker-writable
  when the daemon judges where Medium agents' folders may go (F3). `ops_worker machine_update medium_agent_folders warn|on` sets
  daemon.json `mediumAgentFolders` remotely, as `store_lock` does. Docs: worker-root.md, "Medium agents' temp folders and cargo
  home". Tests: `mediumFolders.test.ts`, `cleanupFolders.test.ts`.
