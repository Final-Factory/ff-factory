- **A request is no longer left with no worker when its "not moved" decision leans on a worker that is finished** (w4496,
  lothsahn: "the 'another worker works on it' check must count only workers that are still on the request with work left").
  When a waiting worker is taken off a request as "not moved (w2079): its worker X works on it", X now counts only when it
  has work left: not a worker that said DONE for its part (the record behind "said DONE for its part; still on it"), not a
  leg an earlier pair attempt replaced, and not a leg of a finished pair run unless it took on what is left (mid-turn on it,
  or holding a wait of its own on the request). With no such owner the request moves (a moved copy starts) or waits for
  room, as w2079 does when nobody holds it. w4207's fix author was taken off at 23:57Z on 2026-11-16 because of a leg that
  said DONE at 23:37Z, and the request went Stalled. Tests: `resumeMoveOnce.test.ts` (w4496).
