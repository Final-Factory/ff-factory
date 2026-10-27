- **A past wait no longer makes a wait cycle (w2371):** the blocker watch kept resuming a request Blocked on its timed
  leg because the leg's last report still said it waited on the request, after the request had answered it and while
  the leg waited only for a free sandbox. A worker's still-open line now counts as a wait only while no message to it
  waits for capacity and no worker of the request it names has finished a turn since that report.
