- **Warn-only: lower work taking a game sandbox that higher queued work waits for** (w6432, lothsahn). Three times on
  2026-11-27 normal work took a lothdesktop sandbox while w6431 (frantic, a release) was queued for one: a move off offline m5
  six seconds after w6431's start there failed, a move off offline BEAST, and a released worker resuming into the sandbox it
  had just given up for w6431 (the computer was at its agent cap, which w3507's yield did not count). The portal now logs
  `(w6432, warn-only)` lines where a room move, an away move or a released worker's resume does so, and counts a failed
  start as queued work on its computer for 10 minutes. Nothing changes yet; a later PR makes them wait. Tests:
  `w6432FranticHold.test.ts`.
