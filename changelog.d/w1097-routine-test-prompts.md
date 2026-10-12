- **A test step's delete of its own temp output no longer waits for a person** (w1097, lothsahn: "Why did it do that,
  and how do we allow it to do what it just needed to do without a complex bash prompt?"). In bypass mode Claude Code
  still asks about an `rm` its dangerous-rm check flags (`$TMPDIR/*.log`, `$TMPDIR/{a,b}`), and the session answered that
  only for a command made of deletes alone. Now, when that check is Claude Code's reason, the session also answers a
  longer command (a function, a retry loop, a copy, a script run) whose every delete is inside the worker's own temp
  folder; anything else still asks. Claude Code's reason is kept on every prompt and shown on its card, and
  `scripts/cleanup-approvals.ts` counts every prompt by kind. The worker brief gains "Shell steps that never wait for a
  person": a new folder per run instead of deleting the last one, multi-step logic in a script file in `$TMPDIR`, and the
  game repo's `scripts/game_data.py` for backing up and restoring the game's settings and saves. The save-copy rule and the
  brief know the game's `UserData/saves`. Needs a portal deploy and the machine daemon update that follows it. Docs:
  self-recovery.md ("Routine test steps without a prompt"), attachments.md. Tests: `tempDelete.test.ts`,
  `agentSession.test.ts`, `cleanup-approvals.test.ts`, `evidenceRules.test.ts`.
