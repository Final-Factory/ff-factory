- **A `release` priority above urgent, and strict priority in every queue** (w4620, lothsahn: "Let's add a new priority
  called release that's above urgent and not have special handling for releases... Let it go through the priority process
  being built"). Priorities are release, urgent, high, normal, low; every queue serves a higher one before every lower one
  queued, whatever came first, and first come first served only within one priority. No aging; a running exclusive turn
  is never cut short. The queues: placement (the capacity order and released workers' resumes), the Unity slot queue
  (player builds, `unity-slot run`, editor starts; it read no priority before), the bench queue's priorities.json (release
  sent as urgent with `level: release` for old bench_queue.py copies; sessions with no open request are low), and timed
  runs (the daemon's own queue now starts the highest priority first too, not first come; the portal still steps back a run
  waiting for its first ticket). Removed: the release builder's urgent override and exempt mark, the reclaim hold's release exemption, the urgent
  release lane's pre-empt and the w1962 raise of a passed shared ticket to urgent. A lower-priority exclusive turn no
  longer stops a higher-priority build. Each jump is logged naming both items (`strict priority (w4620)`).
