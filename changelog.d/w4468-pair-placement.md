- **Queued pair runs are placed again when anything that kept them out changes, and one that cannot be placed shows as
  Stalled with the reason** (w4468; lothsahn: "How did those pair runs get stuck? Please find and fix how that happened").
  At about 21:45 UTC on 2026-11-16, five pair runs (w4441, w4334, w4462, w4460, w4207) sat Queued for capacity for hours
  while computers were idle. The fixes:
  - A pair re-queued because a person started playing (w2304), or because a computer was paused or offline, no longer avoids
    that computer for good. The play hold, the pause or the offline spell keeps it out only while it lasts. On load, avoids
    written that way before this change are dropped, and the request's log says so.
  - The queue is placed again when a person's game ends, when a `placement.*` setting changes, and when decide_work
    re-marks a queued pair.
  - A pair whose peers are spread may be hosted by a Mac (w3697). "Two-computer pair lab" and a person's "a Mac may host"
    now count as spread, as does the new `split` mark, set by `request_pair split` or `decide_work pair_split`
    ("none" clears it). The w3697 sentence that request_pair writes into a brief is no longer itself read as a lab, and a
    split pair does not get that sentence.
  - `decide_work pair_allow` takes computers off a pair's avoid list when a person's note widens where it may run.
  - The computers a dispatcher named when it queued a pair no longer narrow where the pair may start. They had hidden
    biscuit's room from w4462 in the WRONG flag, the capacity ping and the room view.
  - A queued pair that no computers can take together (held, offline, avoided, or a Mac refused) is Stalled, with each
    computer's reason. It returns to Queued by itself when a hold lifts or a computer comes back.
  Needs a portal deploy.
