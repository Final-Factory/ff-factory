- **Timed work waiting on m5 is re-placed** (w1872; lothsahn: "Have the dispatcher replace anything waiting on timing on
  m5"). decide_work queue refuses timed work on a computer that takes no timed runs, even when its worker named it. A leg
  or Queued request already waiting there is moved to the computers "Next timed work" ranks, and the dispatcher is told.
  stop_agent move_to refuses it too. "Next timed work" now also lists the computers without room, smallest first, and
  naming m5 no longer makes timed work Mac-only. A negated mention ("no
  bench lock needed", w1900) no longer marks work timed, and the all-busy line names where timed work goes next.
