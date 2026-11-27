- **The shared lock's warn lines no longer count the daemon's own writes, and a `uv run` logs once an hour** (w5615, from
  w6213's live warn run on m5, 2026-11-27). macOS's file events reached the watch 28-33 ms after the daemon's own write
  ended (a players broker `slot.json`, a clone), so they were logged as a worker's: the daemon now counts its writes as its
  own for 2 s after they end, and every players broker call and the whole clone tick (with its merge-back) count as its
  writes. uv's random `.tmp*` build folders count as one name per folder, where each run logged a line before. A cache
  clone is refreshed only while nothing holds its sandbox's tree, a `unity-slot run`, a batchmode Unity or a night
  included (review w6212 L4). Warn mode only; nothing is refused. Applies at the daemon's next update. Docs:
  worker-root.md. Tests: `slotCaches.test.ts`.
