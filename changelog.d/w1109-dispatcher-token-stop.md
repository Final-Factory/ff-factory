- **At 95% of the dispatcher's token, its workers save their work and stop** (w1109, lothsahn: "at 95%+ session or weekly
  usage the dispatcher asks all workers using the dispatcher key to stop, save their work and push"). When either meter of
  the token `claudeAccounts.dispatcher` pins reaches `vault.pool.dispatcherStopPercent` (new, default 95, settable with
  `set_app_config` like the other pool limits), every worker mid-turn on that token gets one `[token stop]` message per
  crossing: commit and push its work (commit locally and say so if the push is refused), report, end its turn. One still
  mid-turn 15 minutes later is interrupted. Its requests then go Blocked on that token's limit (a gate of its own), and it is
  resumed when its person's pool can serve a worker again, its process restarting on a token with room. Not asked: the
  dispatcher, the orchestrators, the ops worker, standing agents, idle workers. From the same reading no new worker is placed
  on that token: a meter at the stop line counts as inside the dispatcher's reserve, which closes the last-day gap where 95-99%
  weekly was outside the shrinking buffer and the token's one slot was free. Docs: vault.md section 4 ("The stop line").
  Tests: `dispatcherStop.test.ts`.
