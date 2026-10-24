- **FFBox's board check no longer re-reads every request's words** (w2044): each `board_check` worked out the concepts
  (server/boardMatch.ts) of every request in its lookback, twice, and blocked the event loop 1.2 to 1.8 s (stall
  profiles 2026-10-24 15:23 and 15:47Z). Each request's concepts are now kept until its title or the start of its brief
  changes; the answers are the same.
