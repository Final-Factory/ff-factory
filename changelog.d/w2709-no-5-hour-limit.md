- **A token whose plan has no 5-hour limit says so, and the pool never judges it on a made-up 50%** (w2709). lothsahn,
  2026-11-01: "Why do a lot of the tokens not show 5 hour session usage?", then "There is a recent change by anthropic to
  get rid of 5 hour session limits." Anthropic removed the 5-hour limit for verified Ultra (formerly Max 20x) accounts on
  2026-10-30, and vault-ben-3, vault-ben-1 and vault-lothsahn-1 stopped getting the `anthropic-ratelimit-unified-5h-*`
  headers at their next 5-hour reset. `metersOf` filled the missing meter in as 50%, shown as "5-hour 50%" as if read. A
  reading with the weekly window and no 5-hour one now reads "no 5-hour limit" in the accounts lines, the poll log, the
  pool line, the reserve line and the dashboard, counts as 0% on that meter (the 80% hold and the 20% buffer never trip),
  and a live session's 5-hour rate-limit event brings the meter back. A meter still missing otherwise reads "unknown".
