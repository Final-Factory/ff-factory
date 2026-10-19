- **fff-health gives a freshly started portal 5 minutes before checking it** (w1537): `HEALTH_START_GRACE_SEC` goes from 120 to 300.
  After the FFBox host rebooted, nine Actions runners fetching git-lfs at once saturated its disks; the portal sat blocked on
  reads loading its 7.2 GB data folder, and fff-health restarted it at 220 s and again at 340 s (12 s after it had recovered),
  each restart starting the load again. A hang later in the portal's life is still restarted after 4 failed checks. A VM whose
  `/etc/fff/fff.conf` sets `HEALTH_START_GRACE_SEC` itself keeps its own value.
