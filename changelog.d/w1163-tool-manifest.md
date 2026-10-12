- **One tool manifest** (w1163, lothsahn: "Can we make a manifest for all tools, grouping them in reasonable groups, allowing
  you and the workers and dispatcher to load the ones they need?  Only load the very most frequently used tools all the
  time?"). `server/toolManifest.ts` lists every MCP tool an agent gets (dispatcher, a person's orchestrator, `/mcp`, the ops
  worker, workers, standing agents): its group, who has it, who carries it in every call. The server builds each kind's
  tools from it, and every tool carries its group as a `ToolSearch` hint: `select:<name>` loads one, `group_<group>` a
  whole group. The carried sets now follow measured use: the dispatcher adds `agent_transcript`, `stop_agent`,
  `switch_branch`, `unity`, `search_transcripts`, `interrupt_agent` and defers `create_sandbox`, `list_branches`,
  `set_agent_title`; a person's orchestrator adds `search_transcripts` and `max_activity` and defers `list_sandboxes`;
  workers carry none (as before). No agent loses a tool. Applies at each coordinator's next process start after a portal
  deploy, and to workers once their machine's daemon is updated. Docs: tool-manifest.md. Tests: `toolManifest.test.ts`.
