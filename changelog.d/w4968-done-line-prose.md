- **A DONE line that goes on in prose after a full stop closes its request** (w4968): `DONE: w4964. ffu PR #924 merged …`
  was read as no DONE at all, so w4964 sat Stalled for 1.5 h until a sweep closed it by hand. The still-open line for
  w4963 in the same message was never the cause: each line was always handled for its own request. A `Learned:` sentence
  inside that line (`… pre-1.0: no. Learned: nothing new; …`) now counts too, so such a DONE is not refused for a missing
  Learned line. Needs a portal deploy.
