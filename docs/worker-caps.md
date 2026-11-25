# Worker caps: memory, processes and temp disk (w5554)

One worker's agent host and everything it starts are capped, so that a runaway or hijacked worker cannot fill a machine's RAM
or disk and take every other worker and editor there with it (item 25 of the rogue-worker audit w5451; lothsahn: "File it:
generous per-worker memory, process and temp-disk caps"). The caps are generous on purpose: a normal turn, even the heaviest
we measured, never reaches them. Code: `machine/workerCaps.ts`, `machine/winJob.cs`, `machine/linuxScope.ts`.

## The caps

| Cap | Value | Rests on |
| --- | --- | --- |
| Memory, the whole tree | 80% of the machine's RAM, at least 8 GiB (BEAST and LothDesktop, 64 GB: 51.2 GB; biscuit, 27 GB: 21.6 GB; m3, 18 GB: 14.4 GB) | **Measured**: the heaviest normal worker is three batch Unity player builds at once, about 45.5 GB on 64 GB LothDesktop (24.5 GB of Unity, 21 GB of Burst's bcl, w469); one build about 15 GB. Normal worker turns on BEAST (w5554, 20 s samples over 20 min): 0.3 to 1.0 GB commit; a cargo build tree 3.4 GB. **Guess**: the 80% share. The 20% left over is for the daemon, the portal and the editors. |
| Processes at once (Windows, a Mac) | 2048 | **Measured**: a worker's tree on BEAST peaked at 3 to 38 processes, and a cargo build at 35 (w5554). **Guess**: some tens more for a batch build. 2048 is 50 times the measured peak. |
| Tasks at once (Linux TasksMax, which counts threads) | 16384 | **Guess**: a Unity build runs some hundreds of threads. 16384 covers three builds and a cargo build at once, and is far under the kernel's pid_max. |
| Temp folder (`$TMPDIR`, `<root>/tmp/ffa-<session>`) | 60 GB | **Measured**: the biggest worker temp folder ever seen was 36.5 GB, a game clone with its Library (LothDesktop, 2026-11-08, w3686). A cargo target reached 23.3 GB (lothdesktop clean-up log, 2026-11-24). The 15 GB warning (`server/tempSizeHook.ts`) comes long before the cap. |

`CAP_LIMITS` in `machine/workerCaps.ts` holds them; `capsFor()` works them out for a machine.

## What is capped, by OS

What a cap holds: the worker's agent host (`machine/agentHost.ts`), its claude, and every tool claude runs. That includes
shells, builds, background jobs, and a batch Unity under `unity-slot run`. A `--detach` run is covered too: it leaves the
process tree but not the job or the scope.

- **Windows: a job object.** `machine/winJob.cs` is built once per source version into `<appDir>/bin/ffjob-<hash>.exe`, using
  PowerShell's Add-Type and the .NET Framework compiler that every Windows has. It is built in the daemon's folder, which a Low
  worker cannot write.
  - The host starts it before claude, and it puts the host in a new job. The job has a commit limit for the whole job
    (`JOB_OBJECT_LIMIT_JOB_MEMORY`) and an active-process limit, and allows no breakaway.
  - The kernel refuses an allocation or a process past a limit. The job's completion port reports it, and the helper also
    reads the job's process count every 3 s. A Git Bash fork refused by the limit was seen posting no port message.
  - Nested jobs work: node's own and the Task Scheduler's. libuv does not break a detached child away, so detached tools stay
    in the job (measured).
- **Linux: the host's systemd scope.** The daemon starts each host in its own scope (`machine/linuxScope.ts`, w2474). A
  worker's scope gets `MemoryMax` and `TasksMax` where the user manager delegates the memory and pids controllers.
  - `probeLimits` checks this by having a test scope read its own `memory.max` and `pids.max` back, because systemd takes the
    properties even where nothing enforces them.
  - Past `MemoryMax`, the kernel's OOM killer ends the biggest process in the scope. `OOMPolicy=continue` keeps the rest,
    host included.
  - Past `TasksMax`, a fork fails.
  - The host reads the scope's `memory.events` `oom_kill` and `pids.events` `max` counters every 2 s, to tell the worker.
  - Where the controllers are not delegated, only the temp cap holds there. The host's log says which.
- **macOS: a watch, not a kernel limit.** macOS has no unprivileged per-tree limit:
  - `RLIMIT_AS` and `RLIMIT_DATA` are per process and count reserved address space.
  - `RLIMIT_NPROC` counts the whole user.
  - Jetsam limits and coalitions need root or an entitlement.
  - `RLIMIT_RSS` is not enforced (xnu sources).

  So the host reads its tree (`ps -axo pid=,ppid=,rss=`) every 2 s and ends the tools when their resident memory or process
  count is over the cap. A fork bomb between two looks is bounded by the kernel's per-user process limit meanwhile.
- **Every OS: the temp folder.** The host reads its temp drive's free space every 2 s. It measures the folder when the drive
  lost 2 GB since the last measure, and at least every 10 minutes. When the folder is over the cap, it ends the tools.

## When a cap is hit

1. The host ends the worker's tools: every process of the job (Windows), the scope (Linux) or the tree (a Mac), except the
   host and its direct children (its claude, which every OS starts directly or execs in place). The session goes on. If a
   tool claude started (a stdio MCP server among them) was ended with the rest, claude says so on its next use.
2. The worker's next tool result carries a note (`server/workerCapNotes.ts`, a PostToolUse hook). The note says which cap was
   hit, its limit, what was seen, how many processes were ended, and what to do next.
3. The portal writes a line into each of the worker's open requests' ledgers through the `workerCap` signal
   (`server/agents.ts` `onWorkerCap`), for example "worker 1a2b3c4d hit its memory cap (51.2 GB for the agent and every tool it
   runs): FF Factory ended 12 of its tool processes (w5554)". The host's `host.log` has a line for every hit.

One cap is reported at most once a minute, and enforced every time.

## Unity editors are not capped

A sandbox's Unity editor is started by the daemon (`machine/unity.ts`), outside the agent host, and stays outside the caps:

- It is the sandbox's, not the worker's. A person may be using it, and the pool keeps it across workers.
- Its size follows the project, not the worker.
- It is bounded already: the 3-editor limit per machine (`machine/unitySlots.ts`, w469), and on Linux its own scope with
  `OOMPolicy=continue`.

A batch Unity that a worker runs (`unity-slot run`) is the worker's, and is capped.

The residual risk is what a worker can make its editor do through the Unity MCP bridge (`execute_code`, for example). That
stays a known gap.

## Known gaps

The caps stop a runaway: a fork loop, a memory leak, or a clone that keeps growing. A hijacked worker that sets out to escape
them still can in some ways, until the fences close these:

- **Linux:** `systemd-run --user` starts a process in a new scope, outside the worker's. The Linux lock refusing the systemd
  user bus is w5562 (docs/worker-fence.md).
- **A Mac:** a process that double-forks, so that launchd becomes its parent, leaves the tree the host watches.
- **Windows:** the job allows no breakaway, and a Low worker cannot create a scheduled task (measured, w5451). No escape is
  known.

## Proof

All runs are inside the test's own process tree.

**`server/workerCaps.test.ts`** has a stand-in host, its "claude", and tools.

On Windows (BEAST, measured):
- A fork bomb past a cap of 8 was refused and its tools ended.
- A tool that asked for 2 GB more under a 1 GiB cap was refused, and the memory cap was reported.
- A temp folder over its cap ended both tools.
- 40 tools under the real caps were left alone.

In all of these, the host and its claude went on.

The temp and normal-tree tests also run the tree path on Linux CI.

Earlier helper legs on BEAST:
- A 300 MB grandchild was allowed and its 1500 MB request refused under a 600 MB job.
- At a cap of 25, a Git Bash fork bomb was stopped and 24 processes were ended, and the root went on.
- At 4000 MB and 400 processes, a heavy leg (80 forks, 300 MB) was not touched.
