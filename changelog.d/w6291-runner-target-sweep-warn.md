- **FFU runners' cargo targets get a warn-only cap, and Dev Drive disk use can be measured** (w6291, after LothDesktop's
  `ffu-runners` grew from 15.9 to 22.1 GB in a day; a runner that takes jobs is never idle 14 days, so its 19 GB target
  had no cap but a low pass taking the whole job folder).
  - The daemon's stale step now plans the ffu slots' stale-unit sweep for each idle runner's `_work/<entry>/target`:
    48 h window, narrowing while over a 24 GB cap, then the whole target over the cap.
  - Mode `warn` (the default) removes nothing. It lists `warn-only (runnerTargetMode warn, w6291): would take …` and
    counts misses in `ffu-runner-sweep-warn.json` in the daemon's folder. Enforcement comes in a separate PR.
  - `players` and `player-cache` are already bounded by their owners: the slot count, and `player_cache.py`'s 8
    entries / 24 GB. They are unchanged.
  - New: `scripts/disk-usage/diskuse.ps1`, which gives the real (union of clusters) and exclusive size per folder on
    ReFS, where `du` counts block clones and hard links again.
  - Docs: self-recovery.md, sandbox-disk.md. Tests: `w6291RunnerTargetSweep.test.ts`.
