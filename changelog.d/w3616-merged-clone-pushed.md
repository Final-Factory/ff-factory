- **The clean-up no longer keeps a clone for good once its PR merged** (w3616, lothsahn). A single-branch clone whose PR
  branch was merged and deleted looked like it held a commit on no remote, so it was kept for a person forever (38.7 GB on
  biscuit). The clean-up now asks GitHub (or a local remote) whether that commit is in the default branch's history; when
  it cannot tell, it still keeps the clone.
