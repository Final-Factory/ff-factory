- **The dispatcher can run on one named vault token** (w996, lothsahn: "Please make Lothsahn's token the dispatcher token").
  `claudeAccounts.dispatcher` takes `"vault:<entry name>"` (e.g. `"vault:vault-lothsahn-1"`, an owner's setting; the
  orchestrators' `"vault"` is each person's own pool and stays theirs). The dispatcher's reserve (5% of the week per day left,
  20% of the 5-hour window) moves to that token, so the pool's workers keep off it as they did off the token file, and the
  dispatcher takes no pool slot there (its process is not counted toward the one-at-a-time slot). A token the vault cannot
  give later falls back to the token file or host token with a warning, not a stop. Applies at the dispatcher's next process
  start after a portal deploy. Docs: accounts.md, vault.md ("The dispatcher on a vault token"). Tests:
  `dispatcherVault.test.ts`.
