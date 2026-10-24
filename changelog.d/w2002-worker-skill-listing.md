- **A worker's skill listing is about 6,500 characters shorter** (w2002, lothsahn: "File the compaction pilot plus the
  base-context trim and noise fixes"). Workers start with the skills they never invoke hidden from the model
  (`WORKER_HIDDEN_SKILLS`, Claude Code's `skillOverrides` "user-invocable-only": a person's `/name` still works): dataviz,
  claude-api, update-config, keybindings-help, simplify, fewer-permission-prompts, loop, schedule, workflow-authoring, run,
  init, security-review, plugin-authoring, code-review, code-review-sonnet, unity-mcp-skill and therapy. None of them was invoked
  in beast's 361 worker sessions of the last 14 days (claude-api once). The marketing plugin (`ff-marketing@ff-marketing`) is
  off too, unless the worker's title or request names marketing work (`MARKETING_WORK`). Every ff-agents, ff-speckit and
  ff-discord skill stays: Claude Code applies skillOverrides to no plugin skill. Measured on a probe session on beast: the
  listing went from 18,098 to 11,593 characters (46 to 32 skills). Docs: worker-base.md. Tests: `machineUnityMcp.test.ts`.
