- **A sandbox's two Library caches share one cap** (w2752, lothsahn: "Please fix the cleanup and pruning, learn what's wrong
  on that machine, and apply it as a cleanup improvement for all machines to run"): the release trim keeps the newest 4 GB of
  `BuildCache` and `BurstCache` together (it was 4 GB each), and the regular clean-up's `sandbox-lib-cache-cap` takes both
  whole once together they pass 6 GB and are idle an hour (it was 6 GB each). lothdesktop/slot2 kept 4.000 GiB of each after
  its trim, 8 GB over its neighbours, with neither rule firing.
