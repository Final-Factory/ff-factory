- **A batch editor a fenced worker starts can be pinned over Unity MCP** (w5746, lothsahn: "File the w5693 follow-up at
  high"). `unity-slot run` now gives the editor it starts a bridge status folder the worker may write
  (`FF_UNITY_MCP_EDITOR_STATUS_DIR`: `~/.unity-mcp` on macOS, `<root>/home/.unity-mcp` on Linux and Windows) instead of
  the worker's synced folder in the daemon's folder, which the fences keep read-only; the daemon reads that folder and,
  while no editor of its own runs in the sandbox, copies the status of the editor whose pid the project's
  `Library/EditorInstance.json` holds into the sandbox's folder. No fence rule changed. Needs a daemon update. Docs:
  machines.md ("An editor a worker starts itself"). Tests: `w5746WorkerEditorMcp.test.ts`.
