- **The privileged helper warns when a remount stops ReFS dedup** (w6573): `ffsb-helper`'s `mount`, `compact` and
  `grow` wait up to a minute after they remount V: for `ReFsDedupSvc` to log "started monitoring" it (event 6), and say
  in their result when it does not, since twice a remount left the daily dedup job failing until the service restarted.
  Warn only: nothing is restarted. docs/sandbox-disk.md says how to check by hand.
