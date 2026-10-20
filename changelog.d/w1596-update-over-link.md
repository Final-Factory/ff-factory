- **Machine updates over the daemon's own link** (w1596, lothsahn: "Yes, move updates and restarts onto the daemon link;
  drop the SSH need"). The portal updates, restarts and unloads a worker install over its daemon's outbound link: the daemon
  fetches the portal's code as a git bundle, checks its SHA-256, size and commit, and runs the installer's update in a job
  outside itself (a scheduled task, a LaunchAgent) that puts the old code back when the new daemon does not come back. The
  rollout after a deploy, `machine_update`, `machine_daemon restart` and `remove_machine` use it; ssh stays for older daemons.
  A PC that joins with a code no longer turns on OpenSSH Server, adds a firewall rule or asks for a tailnet tag.
