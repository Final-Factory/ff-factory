- **A Windows machine whose daemon stays stuck says it would reboot itself, warn only** (w6792, stage 1; lothsahn: "If the
  daemon is stuck, can we reboot after 15minutes?"). When `run-daemon.ps1` finds its daemon stuck mid-exit (w6784) and its
  own recovery brings back no working daemon (one whose `logs\daemon-alive.json` heartbeat says it is linked to the portal)
  within 15 minutes of the stuck state beginning, it logs `self-reboot: would reboot now (warn only), reason: ...` and tells
  the portal, which logs it and shows a **Self-reboot** chip on the machine's panel. Only a machine that comes back by itself
  is eligible, detected, never named: automatic logon to the daemon's user, a stored password seen without reading it (a
  `DefaultPassword` value by name, or a last boot that logged on by itself), and the logon task. Guards: no reboot while the
  console had input in the last 30 minutes or another session holds it, at most once in 6 hours, and a `supervisor-no-reboot`
  file turns it off. macOS and Linux only say why they are not eligible. This stage has no way to reboot; the reboot comes
  in its own reviewed change once the warn lines look right. Takes effect at each machine's next update that rewrites
  `run-daemon.ps1`. Tests: `supervisorWin.test.ts` (the episode, guards and eligibility under real PowerShell),
  `machine/selfReboot.test.ts`, `machines.test.ts`. Docs: machines.md ("A machine that reboots itself"), worker-install.md,
  self-recovery.md.
