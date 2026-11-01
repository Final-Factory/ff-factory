- **Clean-up never wipes a live Unity cache any more, only what nothing uses** (w2752, lothsahn: "A cold unity station is quite
  slow so we should make sure to not do it often"). The release trim and every clean-up pass take only superseded Burst player
  builds (all but the newest two) and `BuildCache` entry folders older than the newest build past 2 GB, whole folders, never one
  file of one. The 48 h, 6 GB-cap and low-space wipes of `BuildCache`/`BurstCache` and the 24 h drop of `PlayerDataCache` and
  `EntitySceneBundles` are gone; below the critical disk line only, the two caches of the sandbox opened longest ago go whole.
  A cold cache cost lothdesktop's next player build 534 s and 3,844 CPU-seconds against 131 s and 208 warm (measured). This
  takes 3.2 GB from lothdesktop's slot2 without a cold rebuild.
