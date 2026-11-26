- **A clean-up pass removes each step's plan as soon as that step is planned, so a restart no longer loses the whole
  pass** (w5795). On LothDesktop four low-space passes in a row were cut off by daemon restarts after 26 to 58 minutes of
  planning and removed nothing. The last one had spent 21 min on the quick report, 3 on the regular rules and 28 on the
  stale plan before it was cut off in its one removal step. Now the regular rules' items go a few minutes into a pass, and
  the stale plan's items go as soon as it is made. A cut-off pass now also says what it had removed by then.

  Needs a daemon update on each machine.
