- **A reset Dev Drive no longer cuts a machine off from updates** (w1918; lothsahn: "Let's do the root.json backup and have
  the daemon be smart enough to automatically reinstall it in v: if the V: ever gets reset"; "Make sure you can do updates
  over the machine protocol").
  - Every manifest write keeps a spare `root-backup.json` in the daemon's folder (off the drive for a root on it). The
    daemon keeps that copy in step and puts `root.json` back from it when it is missing or unreadable: before its hello,
    before each update or unload over the link, and every 10 s.
  - A connected daemon that offers no update over its link is no longer handed to ssh. machine_update refuses and the
    rollout marks it failed, both saying which file is missing and what to do.
  - Updates over the link record the VHDX's own maximum (read without administrator rights). The disk line measures V:,
    never C:.
  - A machine's clean-up soft threshold is at most a quarter of its drive (never below 20 GB), so an empty 80 GB Dev Drive
    is not "low".
  - Docs: worker-install.md ("Updates over the daemon's link", "The whole root on the Dev Drive"). Tests:
    `machineLink.test.ts`, `machineRollout.test.ts`, `opsWorker.test.ts`, `cleanup.test.ts`.
