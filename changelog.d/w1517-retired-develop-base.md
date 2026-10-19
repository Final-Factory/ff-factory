- **A config that still names the retired `develop` as its base reads as `master`** (w1517; lothsahn: "It should have
  linked the fix to ffbox or something and notified it was closed so ffbox would mention it's fixed in some older version
  and closed the thread. Why did this not happen?"). w1137 changed the default to `origin/master`, but the VM's
  config.json still said `"defaultBase": "origin/develop"`, so the base clone was moved back to develop's last commit
  (f946154b3, 2026-10-12) every 15 minutes, the release lookup read develop's version bumps only, and w1516's
  "already fixed by PR #1597" reached FFBox as `develop@ffa7fc5` with no version, though 0.50.0.102 had carried it
  since 2026-10-13. `loadConfig` now reads a retired base as the trunk beside it (`trunkBase`, `origin/develop` →
  `origin/master`) and says so once at startup (`retiredBaseLine`); change the file's `defaultBase` to clear the line.
  FFBox now finds the release itself too (ffbox 9791b87), so a thread hears its build whichever side is behind.
