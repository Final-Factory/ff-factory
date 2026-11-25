- **The orchestrator tests in eight files** (w5826, asked by lothsahn: "split it into several files by topic"). `server/orchestrators.test.ts`
  (334 tests, 481.7 s on a Windows runner, 196.1 s on Linux CI, the slowest file by far) is now
  `server/orchestrators{People,Requests,Waits,Gates,Pools,Pairs,Legs,Asks}.test.ts`, its helpers exported from
  `server/orchestratorsTestKit.ts`, so `node --test` runs them side by side and `--test-shard` deals them across runners.
  Same 334 tests and 3321 assertions, unchanged; the docs that named the file now name `orchestrators*.test.ts`.
