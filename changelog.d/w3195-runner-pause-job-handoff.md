- Bench turns no longer lose CI jobs (w3195): an exclusive turn paused a runner's listener in the second it was handed
  its next queued job (no worker yet), so GitHub dropped the job after 10 minutes with "lost communication with the
  server" (ffu job 127943935420 on biscuit, 2026-11-06). A listener is now paused only when its own `_diag` log says it
  has been idle for 10 s, and is continued at once when that log took a job as the pause landed.
