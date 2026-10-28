- **LothDesktop takes timed runs** (w2442): `BIG_TIMED_RUNS` in `server/timedAsk.ts` names the big worker computers that
  take timed runs anyway (until now only play-only computers and ones with 1 to 4 agent slots did, w1996). A run there holds
  LothDesktop's exclusive bench ticket for each turn, as on LothLaptop. It ranks after every small computer, so it gets a run
  when that run names it or when no small computer can take it. lothsahn, 2026-10-28: "Move that job to another machine".
