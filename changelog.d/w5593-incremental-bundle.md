- **A machine's update sends only what it lacks** (w5593). The portal sent every machine the full 29 MB bundle of its code, and
  BEAST, which took it at 35-50 KB/s on 2026-11-25, never finished it in the daemon's 480 s, so it stayed on 0a239f1c through
  three deploys. Now the bundle leaves out what the commit the daemon runs already holds: 790 KB from BEAST's commit to
  a1701f9. A daemon whose checkout lacks that commit refuses it, and the full bundle goes in the same call.
