- **A worker's temp folder is watched while it runs** (w3686; temp folders had grown to 36 GB each mid-run and filled machine disks).
  At most every 10 minutes the worker's own agent process measures `$TMPDIR` (server/tempSizeHook.ts). Over 15 GB, and again at each
  further 10 GB, the worker's next tool call carries a note naming the biggest folders to delete, and one line goes into the
  request's ledger log (a `tempSize` signal, no protocol bump).
- **Workers delete the big things they made before DONE** (w3686, Ben: "Please address this problem with a harness update so
  you're cleaning up after yourself"). The worker prompt's Disk space section no longer says "leave it there, no clean-up step
  before DONE": a clone, cargo target, player build, recordings or repeat output goes with a written-out `rm -rf "$TMPDIR/<name>"`
  (asks nobody), checked with `du -sh "$TMPDIR"`.
