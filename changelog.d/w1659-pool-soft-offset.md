- **A token's room before its weekly reset is used sooner, by weight instead of a "goes first" switch** (w1659, lothsahn:
  "Instead of having it go first like that, can we just adjust the weighting so it gets used sooner? Like subtract 12 or 18
  hours from the time remaining"). The pool's score now divides a token's weekly headroom by its hours to the reset less a soft
  offset, `vault.pool.resetOffsetHours` (new, default 12): about 12 hours off days out, bending smoothly near the reset so no
  token jumps the queue at an hour mark. w1539's "goes first" rule is gone; its lift of the 95% and 99% caps inside the last 12 h
  (with the one-other-token burst floor) stays. Ben's pool at 06:00Z 2026-10-21 now puts vault-ben-2 (12% left, 26 h) ahead of
  vault-ben-3 (58% left, 119 h). Replayed on the journal's meters 2026-10-06..21 (`scripts/pool-replay.py`): the room is used
  sooner and a little less is lost at resets, for slightly less burst readiness than w1539. Docs: vault.md section 4 ("Near a
  weekly reset"). Tests: `tokenPool.test.ts`, `vaultPool.test.ts`.
