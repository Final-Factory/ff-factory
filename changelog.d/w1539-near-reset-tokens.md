- **A token's last room before its weekly reset is used, without draining the pool's burst windows** (w1539, lothsahn:
  "make sure that sessions get used fully by updating the priority logic", then "We don't want it to always use the token about
  to expire first, though, as we want to be able to handle a sudden 5 hour burst of activity"). Inside the last
  `vault.pool.nearResetHours` (new, default 12) before a token's weekly reset, its 95% one-at-a-time and 99% retire caps are
  lifted (that room is lost at the reset), and it goes first, ahead of the w971 score, for the room its share of the pool's pace
  would not use before then. Both only while at least `vault.pool.nearResetFloorTokens` (new, default 1) other token of the pool
  can take a new process, so a pool never ends with one 5-hour window. Far from a reset nothing changes; the 5-hour hold, the
  dispatcher's reserve and stop line, and the orchestrator and ops-worker rules are as before. Measured first (the journal,
  2026-10-06..19): the room left at resets was 0-3%; the replay (`scripts/pool-replay.py`) found that no pick order changes it
  much, that a 12 h or 24 h offset lowers burst readiness, and that this rule keeps it at or above today's. Both settings can be
  changed with `set_app_config`. Docs: vault.md section 4 ("Near a weekly reset"). Tests: `tokenPool.test.ts`, `vaultPool.test.ts`.
