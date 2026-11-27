- **A Linux daemon reports whether its desktop is locked, warn-only** (w6311, lothsahn: w6282's windowed pair leg went on
  biscuit/slot3 behind a locked GNOME desktop and drew no frames). It reads GNOME's ScreenSaver `GetActive`, else
  loginctl's `LockedHint`/`IdleHint` for the user's graphical session, every 2 minutes beside the Steam client; neither
  answering counts as locked for work that draws a window. Until `LINUX_LOCK_ENFORCED` is turned on in its own PR, a
  Linux reading changes no placement: the portal log says `would not place: <machine> screen locked` where it would.
  Applies at each Linux daemon's next update and the portal's next deploy. Docs: machines.md ("Work that draws a window").
  Tests: `w6311LinuxLock.test.ts`.
