- **The two slowest test files split by topic** (w5826, asked by lothsahn: "split it into several files by topic").
  `server/orchestrators.test.ts` (334 tests, 481.7 s on a Windows runner, 196.1 s on Linux CI) is now nine
  `server/orchestrators{People,Requests,Waits,Gates,Pools,Pairs,Queue,Legs,Asks}.test.ts`, helpers exported from
  `server/orchestratorsTestKit.ts`; `server/machineSandboxes.test.ts` (51 tests, 199 s on Windows) is now
  `server/machineSandboxes{Editors,Life,Trim}.test.ts` with `server/machineSandboxesTestKit.ts`, listed in
  `.github/windows-tests.txt` and windows.yml's paths. `node --test` runs the pieces side by side and `--test-shard` deals
  them across runners. The same tests and assertions, unchanged (335 tests and 3330 assertions with main's w5827 test; 51 and 442); the docs that named the files
  now name `orchestrators*.test.ts` and `machineSandboxes*.test.ts`.
