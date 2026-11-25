- **`server/w5564PlayerFence.test.ts` and `server/w5630MacEditorFence.test.ts` pass on Windows, and the Windows job runs
  them** (w5809): each failed 2 tests on a Windows host on path separators. The macOS editor fence's home, the editor's
  MCP status folder and the licensing client's path in `machine/unity.ts` now join with `path.posix` on every host (on
  macOS `path` is `path.posix`, so nothing changes there; their callers run only on a Mac). `machine/playerFence.ts` is
  unchanged: `playerWritable` runs on every OS and rightly answers native paths, which the test now expects.
