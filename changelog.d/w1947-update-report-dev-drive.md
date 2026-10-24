- **A machine update's report says what it did to the Dev Drive** (w1947). The installer's `Dev Drive:` lines (the drive's
  size, and a larger `dev_drive_max_gb` asked of it: "80 GB now, 98 GB asked: the daemon grows it ...") now reach the update's
  report. Before, the report kept only "Settings: none changed", which diffs daemon.json, while the grow is written to
  devdrive.json, so a 98 GB grow that had been recorded read as one that had not.
