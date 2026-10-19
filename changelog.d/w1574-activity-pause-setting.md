- **The activity pause is a per-machine setting, off by default** (w1574, lothsahn: "We want it off on all of the workers
  currently so that they continue to work even if a user is at the station"; "I will be adding some new workers soon that
  will want that on"). Config `machines.activityPause.enabled` (default false) and `.idleMinutes` (default 90), per machine,
  set with `set_app_config` (`machine`), the machine panel's Turn on / Turn off and minutes, or the tray's "Pause when someone
  uses this PC" (written back to the machine's config entry). The portal sends each daemon its setting; a daemon update
  turns it off once on every machine that had it on from w1532, and the portal ignores an older daemon's activity pause while
  the setting is off. While off, a person's keys and clicks are not even kept. The tray's schedule window's **Cancel** closes
  it unsaved (it did nothing: a `DialogResult` button closes only a modal window). Docs: machines.md ("Pausing a machine").
  Tests: `activityPause.test.ts` (a real daemon and portal), `pauseRules.test.ts`, `appConfig.test.ts`.
