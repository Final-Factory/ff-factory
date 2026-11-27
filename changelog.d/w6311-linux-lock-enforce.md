- **A locked Linux desktop now takes no windowed work** (w6311, lothsahn: w6282's windowed pair leg went on biscuit
  behind a locked GNOME desktop and drew no frames). `LINUX_LOCK_ENFORCED` is on: work that draws a window, and pair
  legs that click the game's menus, are never placed on a Linux computer whose GNOME screensaver or loginctl session
  reads locked, or whose lock can't be read; they wait Queued for an unlocked computer, and headless work still goes
  there. The warn-only step (#1432) logged it first. Docs: machines.md ("Work that draws a window"). Tests:
  `w6311LinuxLock.test.ts`.
