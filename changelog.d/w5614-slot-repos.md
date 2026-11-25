- **Slot repos, stage 1 of per-slot isolation** (w5614, design w5544): a new pool setting `slot_repos` (`new` / `all` / `off`,
  off by default; `add_machine` `slot_repos`) makes a sandbox its own git repo borrowing the main clone's objects through
  alternates, so a worker's commits, branches, stash, config and hooks stay out of the shared clone. Its branches and stash
  are kept in the clone on a save, a switch away and a delete; a branch one sandbox holds is refused to another; `all`
  converts one free, idle worktree every 2 minutes in place. The dev-drive move and rehome refuse a slot repo. The way back:
  `off`, then delete and create the sandbox again (docs/machines.md, "Slot repos"). Needs a daemon update; nothing changes
  until the setting is on.
