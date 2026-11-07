- **The shared FFU world's deploy runner is not paused for a timed run** (w3424, ben: "the shared world's redeploy from
  main starts within minutes, not behind busy runners and a bench park"). A CI runner whose folder holds an
  `ff-ops-runner` file is an operations runner: an exclusive bench turn leaves its listener running, so its jobs start at
  once. Only biscuit's `ffu-biscuit-world` (label `ffu-world`, the world deploy alone) carries it; every other runner is
  paused as before (docs/unity-lifecycle.md, "The exclusive turn").
