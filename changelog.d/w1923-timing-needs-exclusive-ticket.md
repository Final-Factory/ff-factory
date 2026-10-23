- **Every timing measurement holds an exclusive bench ticket** (w1923, lothsahn: "How do we make sure workers aren't timing
  things without exclusive locks?", after w1892's worker timed a Burst job in its editor through `unity-bridge.py eval_file`
  for an hour on a LothDesktop at 100% CPU with none). The worker guard (`server/timingGuard.ts`) refuses a Unity MCP
  `execute_code` whose code reads a clock (Stopwatch, ProfilerRecorder, realtimeSinceStartup, `ProfilerUnsafeUtility.Timestamp`,
  ...), a `run_tests` that selects a Performance test, a `manage_profiler` capture or timing read, a shell `unity-bridge.py
  eval`/`eval_file` reading a clock and a `-runTests` selecting Performance tests without `--bench exclusive`, unless the
  worker's session holds a granted exclusive ticket (`ownTimedHold`). Ordinary snippets and test runs are untouched; a
  `// ff-not-timing: <why>` comment lets a clock used as a timeout through. Every check is a line in the queue's
  `timing.jsonl`; the machine view's bench row and `system_status` / `list_machines` show the last hour's timing calls outside a
  ticket (`BenchState.untimed`). The worker prompt says how to take one (`bench_queue.py timed`, `unity-bridge.py --timed`, the
  game repo's PR for w1923). Tests: `timingGuard.test.ts`.
