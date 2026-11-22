- **Fewer permission questions from workers** (w5148, lothsahn: "I just got a bash request. Figure out why I get those
  and how to cut them down 90%"). In bypass mode every question a worker raises comes from one of Claude Code's own checks.
  The session now answers the ones it can judge itself (`server/selfAnswer.ts`):
  - deletes inside its own temp folder, or inside its own sandbox after its own `cd`;
  - commands that only read (`server/readOnlyShell.ts`);
  - commands bash cannot parse, refused with a reason that says how to fix them.

  In the replay of the 21 questions counted over 30 days, a person gets 1 of the last 14 days' 10 (90% fewer) and 5 of
  all 21. Main clones, C:, deletes elsewhere, pushes to master/main, force pushes, secrets and system settings still ask,
  and tests prove it. Claude Code's reason now shows in transcript search and in the orchestrator's relay.
