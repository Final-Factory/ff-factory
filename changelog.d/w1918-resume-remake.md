- **A drive-reset sandbox's remake survives a daemon update** (w1918). LothLaptop's slot1 began its remake three minutes before
  the next update restarted its daemon, and a create cut off by a restart is left as an error ("interrupted while creating")
  that needs a delete and a create. A remake is now marked in `sandboxes.json`; the restarted daemon makes it again, keeping the
  worktree it had added. Test: `machineSandboxes.test.ts`.
