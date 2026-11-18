- **A daemon that connected with its Dev Drive detached offers updates over its link once the drive is back** (w4672): the
  hello offered `selfUpdate` only at connect, so LothLaptop's daemon, which connected on 2026-11-18 at 04:31Z a moment
  before its V: reattached, refused every update over its link until its next reconnect (the rollout failed with "did not
  offer updates over its link when it connected"). While its hello offered nothing, the daemon looks again every 30 s
  (putting `root.json` back from its spare copy, w1918) and sends the new `self_update_offer`, which the portal merges into
  the hello's record. An older portal drops it. Needs a portal deploy and the daemon's own update.
