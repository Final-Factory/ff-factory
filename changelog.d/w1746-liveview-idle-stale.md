- **An idle Live view's editor closes even with a page left open** (w1746 follow-up): a page counts as watching only
  while its tab is visible and focused or touched within 90 s (it says so over the frame socket), so a page left open
  behind other windows no longer holds the editor; coming back to it wakes the worker to reopen it. A tool left on a
  session between turns, a stopped session, a check-in more than 30 minutes away and a portal restart no longer count as
  activity either.
