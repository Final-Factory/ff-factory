- **A worker's own background job at work counts as activity** (w4589, from lothsahn's note on w4568). On biscuit,
  2026-11-17, w4568's worker 202bc503 (slot1) sat between turns while its scenario batches ran. The portal stopped it as
  "idle for 61 min" and released its sandbox, and the leftover sweep then ended the batches. 58 scenarios were lost, and
  the set restarted on lothdesktop/slot5. Now each look of the sweep finds every worker's own jobs that used 2 s of CPU or
  more since the last look (`LeftoverReaper.jobsOf`, `LEFTOVER.BUSY_CPU_MS`). A job is what the worker ran through a shell
  under its claude (a Bash call, `run_in_background`) or outside its agent host (detached, by its FF_SESSION_ID); claude
  itself, MCP servers, timed runs' and people's processes are never jobs. The daemon sends these jobs in its stats
  (`busyJobs`). While the worker's request is open, `Agents.keepIdle` keeps such a worker, so it is neither stopped as
  idle nor has its sandbox released. The sweep keeps a stopped worker's busy jobs, and the processes of its own that drive
  them, while a request waits for it. A hung job uses no CPU and is cleaned up as before, and so is any job once its
  request closes. Tests: `w4589BusyJobs.test.ts` uses real spinning and hung child processes read by the real
  environment and CPU readers; the orchestrators test covers the portal's idle stop. Before the fix 4 of the 5 new tests
  failed; the fifth checks behaviour that did not change.
