- **A login can be deleted: `fffctl user delete ID --by LOGIN`** (w1864; lothsahn: "the portal has no way to remove a login").
  The running portal removes the login with its API keys, sessions, pool entry (w1717) and its other settings, push
  subscriptions and its own orchestrator (the session, its process stopped, and its memory, moved to the memory trash) in
  one step, after checking everything first, and prints what went: key names and counts, never a key or a password. It
  refuses the last owner, the login it is run as or for, and a login another person's pool setting names. `fffctl user list`
  shows the logins. The orchestration worker may run both, `delete` only for a member login and never ben's or lothsahn's
  (`fff-ops-priv` adds `--members-only`). docs/ops-worker.md, "Deleting a member login".
