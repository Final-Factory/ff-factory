- **A machine's clean-up says when a pass starts and how long each step takes, and a pass that a restart cuts off is
  reported at the next start** (w5795). This change is report-only. On LothDesktop on 2026-11-25 the daemon restarted 14
  times in 13 hours. Its low passes needed 67-78 minutes before they removed anything, so restarts lost them, and V: fell
  to 14 GB free.
  - The daemon logs `clean-up (<trigger>): pass started`.
  - While a pass runs, the daemon keeps `cleanup-pass.json` in its app folder. A start that finds it logs the cut-off
    pass and writes a `cutOff` entry to the clean-up log.
  - Summaries and the clean-up log carry `passMs` and `phasesMs`.
  - A low pass first plans the quick scope (the cargo-target cap with the low-space rules) and reports what it would
    free and how long planning took. It removes nothing yet.

  Needs a daemon update on each machine.
