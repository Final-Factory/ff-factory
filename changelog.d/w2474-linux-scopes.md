- **On Linux, each Unity editor and agent host runs in a systemd scope of its own, out of the daemon's cgroup** (w2474). The
  daemon's unit keeps `KillMode=process` so its agents run on through a restart, which left them all in the unit's one cgroup;
  when Unity filled biscuit's RAM and swap on 2026-10-28, the out-of-memory kills at 10:23 and 10:52 UTC took the daemon too,
  and the portal saw biscuit drop. Now `systemd-run --user --scope` starts each one (`machine/linuxScope.ts`), so a kill takes
  that editor or agent and the daemon stays connected. Where no user manager answers, they start as before.
