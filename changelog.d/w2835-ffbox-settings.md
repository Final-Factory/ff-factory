- **`set_ffbox_config` changes any non-secret FFBox setting, not just the two holds** (w2835, lothsahn: "Please update
  ffbox's tunnel so you can change its settings yourself"). FFBox now lists about 85 keys of its config.json (the
  `fff.*` switches with `fff.dev_requests`, the intake pools, GitHub review and feedback settings, timings, models,
  rates, quiet hours, clustering, release housekeeping), each with its kind and range checked the way ffwatch reads
  it, and whether it applies live or when FFBox restarts. A restart key is written and FFBox's updater restarts it
  within 3 minutes, refused while a release builds or uploads. Secrets, tokens, operator identities, paths, addresses,
  git refs and release decisions stay unsettable, and the listing says why for each. The tool takes numbers, strings,
  true or false, lists of strings and null. Docs: ffbox.md ("Changing an FFBox setting"), ffbox-connector-contract.md.
  Tests: `ffboxConfig.test.ts`.
