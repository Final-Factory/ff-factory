- **An urgent release builds in its build computer's slot1, whose Library stays warm** (w1668; lothsahn: "Let's make sure
  that urgent builds always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as
  possible"). `build_plan start` answers a builder outside slot1 `Not yet (w1668)`. FF Factory empties slot1: a worker
  there is released to another sandbox on its branch, its work saved, and one mid-turn is stopped after 2 minutes. Then it
  moves the builder in (`server/releaseSeat.ts`); if slot1 is still busy after 10 minutes, the builder builds where it is.
  On BEAST and LothDesktop slot1's Library is never trimmed or reseeded (`SandboxPool` `warm`). Measured on biscuit, a
  Linux release build took 81 s warm, 244 s with the trimmed caches gone and 2688 s with no shader cache.
  docs/orchestrators.md, "in slot1".
