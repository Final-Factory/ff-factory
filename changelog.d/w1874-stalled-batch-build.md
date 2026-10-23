- **A worker clears its own stalled batch Unity build within minutes, and a `unity-slot run` dies with what started it** (w1874,
  lothsahn: jobs that hang or jam should be unjammed, and the portal fixed so they don't). On biscuit a worker ended the
  background shell that ran its build script; the `unity-slot run` wrapper lived on under systemd with its hung batch Unity,
  and `clear_batch` kept it ("its parent node is alive", under an hour old) while it held a Unity slot and the sandbox's
  Library. Now: `unity-slot run` watches its caller every 2 s and ends its command's tree when the caller is gone or it gets
  SIGTERM/SIGHUP (SIGTERM, then a hard stop after 20 s); the reaper looks through a wrapper to the wrapper's caller, so a
  wrapper left under init makes its build an orphan; CPU counts as progress only at 10% of a core or more (one 2 s burst of a
  hung build no longer restarts its stall clock); and `clear_batch` from the worker whose session started the build (or any
  worker of its sandbox, when the run recorded no session) ends it once its log has been silent for 20 min, or log and CPU
  for 10 min, whatever its age. The windows come from 690 healthy build logs on biscuit, whose longest silence was 592 s (a
  Burst step). The portal sends the worker's session with `clear_batch`; an older daemon ignores it and keeps the old rules
  ([unity-lifecycle.md](../docs/unity-lifecycle.md#orphaned-and-hung-batch-builds-are-ended-w791)).
