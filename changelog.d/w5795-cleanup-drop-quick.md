- **A low-space clean-up pass no longer spends its first 21 minutes on a report that removes nothing** (w5795). The quick
  plan added to measure a faster first removal took 21 min on LothDesktop before the pass removed anything, and no pass
  that ran it finished to report a result. Each step of a pass already removes its plan as soon as it is planned, so the
  low pass now starts with the regular rules.

  Needs a daemon update on each machine.
