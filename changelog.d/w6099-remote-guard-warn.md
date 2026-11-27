- **The daemon logs a push or fetch to an origin that is not GitHub** (w6099, follow-up A of w6091's review of #1367):
  a worker could point a sandbox's origin, or its push URL, at a bare repository it planted on the disk, whose
  receive-pack, hooks and config would then run in the daemon's process outside safeGit's fence. saveWork, switchBranch
  and the ffu-slot rescue now check every fetch and push URL of origin first (`server/remoteGuard.ts`), and log
  `remote guard (w6099, warn-only): would refuse ...` for any that is not GitHub over https or ssh. Warn-only: a
  separate PR enforces it. Needs a portal deploy (machines update themselves after).
