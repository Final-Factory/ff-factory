- **A timed run gets its exclusive ticket on LothDesktop** (w2446): a big computer's bench queue (w1995) let an exclusive
  timing ticket through only for a session whose timed_place answer was "here", and a timed run's ticket carries its
  worker's session, from another computer, which never asked about this one. Both runs sent to LothDesktop after w2442
  gave up before a leg ("w1995: an exclusive timing ticket here waits for the dispatcher's answer"). The portal now
  answers "here" in the bench priorities of the computer each live run was sent to, and pushes them just before it sends
  the run. The turn limits (30 min, warned at 25) and the quiet machine of an exclusive turn are unchanged.
