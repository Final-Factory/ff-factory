- **A Windows machine that comes back by itself now reboots when its daemon stays stuck 15 minutes** (w6792, stage 2;
  lothsahn: "Build the live stage now; it gets its own independent review before it merges"). Where stage 1 logged `would
  reboot now (warn only)`, `run-daemon.ps1` now logs `self-reboot: rebooting now, reason: ...`, writes the reason for the
  next daemon to report, and runs `shutdown /r /f /t 0 /d u:0:5`; if that fails, does not answer in 60 s, or the machine is
  still up 10 minutes later, it calls `NtShutdownSystem`, which needs no Windows service. A reboot that could not happen
  is logged and shown on the machine's panel (`tried to reboot itself at T and could not (...)`). New guards from the
  stage-1 review: no reboot while the daemon works but cannot reach the portal (the heartbeat's `portalUnreachable`, held
  up to 2 minutes after the last failed try), nor in a daemon's first 2 minutes; "linked" now means the portal welcomed the
  link; a `DefaultPassword` value alone no longer makes a machine eligible without a last boot that logged on by itself; a
  hung eligibility check is stopped and no second one starts beside it. Stage 1's guards stay (eligibility detected, never
  named; 30 minutes of console idle; another session at the console; at most once in 6 hours; `supervisor-no-reboot`).
  Takes effect at each machine's next update that rewrites `run-daemon.ps1`. Tests: `supervisorWin.test.ts` (the live
  reboot, both fallbacks, the portal and young-daemon holds, a hung check, under real PowerShell with both reboot calls
  replaced by fakes), `machine/selfReboot.test.ts`. Docs: machines.md ("A machine that reboots itself"),
  worker-install.md, self-recovery.md.
