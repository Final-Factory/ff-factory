- **Every instance on a computer follows the commit Final Factory's portal verified** (w14): `scripts/instance/update-all.ts`,
  run every 5 minutes by a scheduled task beside one list of the computer's instances (`instances.json`), rolls each other
  portal (Light Tree, Lens Scout, demos) to the lead's commit once it has held for 5 minutes and is on main, one at a time:
  drain as fff-update does, stop, `npm ci` and the web build, start, check `/api/health`, then leave `update.verified.json`
  so that portal updates its own machines' daemons. A commit that does not come up is rolled back and stops the batch. It
  also logs each instance's settings that differ from the list. Final Factory's own deploy is unchanged (docs/instances.md).
