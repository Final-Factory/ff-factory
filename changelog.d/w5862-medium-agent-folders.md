- **Medium agents' temp folders and cargo home can move out of the workers' reach** (w5862, from w5838's audit; lothsahn's
  rule: warn-only first). An agent outside a sandbox ran with TMP/TEMP in `<root>/tmp` and CARGO_HOME in `<root>/cache/cargo`,
  both folders fenced workers write, so a worker could plant a script, DLL or cargo `config.toml` a Medium agent then runs.
  The daemon now logs one `WARNING medium agent folders: ...` line at start naming them; daemon.json
  `"mediumAgentFolders": "on"` gives Medium agents `<root>/tmp-medium/ffa-<session>` and `<root>/cache-medium/cargo`
  (kept Medium on Windows, read-only under Landlock and Seatbelt), while sandbox agents keep theirs. A folder that cannot be
  made keeps today's with a WARNING. Docs: `docs/worker-root.md`. Tests: `server/mediumFolders.test.ts`.
