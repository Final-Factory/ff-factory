- **A Windows daemon can start the installed Steam client in the desktop session** (w6727; lothsahn: "Great.  Do it", and
  "I would like self healing as much as possible if it doesn't cause a security or safety problem"). A person's orchestrator
  calls `ops_worker` action `steam_start` with the machine and one of their own open requests. The daemon starts only the exe
  named by Steam's own install record, with no arguments, at Medium as the logged-in desktop user. It refuses when no user
  is logged in on the desktop and does nothing when Steam already runs. Before a players broker launch on Windows, a Steam
  that is installed but not running is started first. Tries back off (2, 10, 30 min), stop at 4 in 6 h, and are logged.
  Dialogs are reported and never clicked. Needs a portal deploy and the daemon update (docs/machines.md, "Starting the
  Steam client").
