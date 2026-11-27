- **A sandbox's cache clone is refreshed only while nothing holds its tree** (w5615, review w6212 L4). Before, a sandbox
  with no live agent and no editor counted as idle, so its daily clone refresh could run under a `unity-slot run` batch
  job. Now it also has to pass the check `switch_branch` makes (`switchHold`: a `unity-slot run` holding slots for it, a
  batchmode Unity with its project open, a night running in it); a failed check counts as busy. A first clone is still
  made idle or not. Applies at the daemon's next update. Docs: worker-root.md.
