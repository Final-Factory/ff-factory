- **The token pool hands out the token whose weekly window resets soonest** (w2722). lothsahn, 2026-10-31: "Now that there
  is no session limit for most of the subscriptions, we just want to use the one that will reset soonest." Among the tokens
  every cap allows (the 5-hour hold where a 5-hour limit exists, one at a time at 95% weekly, retired at 99%, used up at
  100%, the dispatcher's reserve and stop line), the soonest weekly reset goes first; ties go to the fewer live runs, then the
  name, and a token with no reset time last. The headroom-per-hour score, its 5-hour factor and the 24 h soft offset are gone;
  `vault.pool.resetOffsetHours` in config.json still loads and does nothing. The pool listing shows the tokens a worker may
  take first, each part in that order. A running session is never moved.
