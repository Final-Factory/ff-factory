- **A finished worker's temp folder loses its rebuildable bulk, not only its caches** (w2223: LothDesktop's V: clean-up,
  w2219, freed 0 GB of 60 while about 55 GB sat in four finished workers' folders, kept whole by the 7-day reopen hold).
  For a worker every request of which closed (stopped, no process names its folder, resumable but owned by no open
  request), the daemon's clean-up now also takes its git clones and checkouts with nothing on no remote, copies of Unity
  Library caches, test output folders and loose non-evidence files of 1 MiB or more, once nothing in the folder was
  written for 24 h, or for 15 minutes while disk is below the soft threshold (then its whole Library too). It keeps
  evidence published nowhere else (the daemon now records what `publish_review` and `publish_attachment` sent, in
  `published.jsonl`), any repo with work on no remote (listed), and open or live workers' folders. `ff-leftovers folders`
  lists the same bulk as DELETE rows inside the kept folder. [docs/self-recovery.md](docs/self-recovery.md) "A finished
  worker's bulk goes too (w2223)".
