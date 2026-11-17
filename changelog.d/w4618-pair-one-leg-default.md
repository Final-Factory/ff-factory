- **A pair run takes one leg unless it needs computers at once** (w4618, from w4596's findings, report r287). `request_pair`
  without `legs` files 1 leg, or 2 when the request names cross_os, steam, timed, split, or a pair lab (`lab.pair-...`) or
  `pair_relay` in its words: ffnightly.py's default lab runs an MP scenario's host and client on one computer, so a second
  leg only waited for a second free computer (w4595, two legs, had not started 2 h 14 min after filing; w4609, one leg of
  the same commit, was done in 51 min). A Queued pair run with none of those reasons, no leg started and no leg count asked
  for is cut to one leg by the blocker watch, and its log says so; a count passed outright (`legs`, `decide_work pair_legs`)
  stands.
