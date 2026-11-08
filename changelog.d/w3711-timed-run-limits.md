- **`timed_run` keeps a run within one bench lock** (w3711; lothsahn: "It should do 10 minute samples and run no longer than
  30m per lock. Figure out why workers are doing such extended tests."). The worker's daemon and the portal now refuse a plan
  whose leg (launch and load included) passes 10 minutes, and, unless `reason` says why, more than 2 rounds or more legs than
  fit in one 24-minute turn; the default rounds go from 4 to 2. The answer quotes the planned play time instead of the
  bound (w3639's run answered "about 106 min", the bound of 8 legs at their kill timeout, and was read as its length; it
  planned about 31 min). A play-only timing computer now plays in turns too: it gives its ticket back after 24 minutes of legs
  whether or not anyone waits and queues again at the back (it held one ticket for the whole run). Needs a portal deploy and
  a daemon update on the worker and timing computers.
