- While another worker's exclusive bench ticket holds a machine, the daemon stops every other sandbox's batch Unity (a
  player build, a test run, a batch compile) and tells its workers to run it again; `unity-slot run` ends its command
  when its bench ticket is revoked under it, and one with no ticket waits for the timed run to end (w1860).
