- **The timed tools describe the rule by size class, not by machine** (w4627, lothsahn; found by w4625's worker). timed_place's
  text called biscuit (4 agent slots, large) a small computer that needs no ask, while the code (`timedAskMark` →
  `isSmallTimed` → `sizeClass`) asks there. It now states the classes (small 1 agent slot, medium 2-3, large 4-6, xlarge 7+)
  and that a small or medium computer needs no ask; timed_run and its `machine` param state their own limit (worker
  computers of at most `SMALL_TIMED_MAX_AGENTS` = 4 agent slots, or `BIG_TIMED_RUNS`). Tests: `w4627TimedToolSizes.test.ts`
  fails on a machine name beside a size word in these texts.
