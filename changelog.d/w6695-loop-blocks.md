- **Four more slow disk calls leave the machine daemon's loop** (w6695, after w6674's hour of BEAST's log on fc94e0eb):
  a command for an agent host (a stop, a message, a decision) is now appended to its `in.jsonl` off the loop and in order
  (one stop held BEAST's daemon 59.2 s at 2026-11-28 04:38Z); the Unity slots arbiter writes its grant, refusal and
  `arbiter.json` files off the loop (14.7 s); the poll timer reopens a host's `out.jsonl` off the loop (6.9 s and 7.9 s);
  and `slots/touch` touches its request file off the loop. A new host waits until the old one's last commands are written,
  a host folder is removed only after them, and a daemon that is going writes the ones still queued before it exits.
