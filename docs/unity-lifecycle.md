# Unity editor lifecycle: start, stop, restart, hang and crash recovery

Unity editors crash and freeze often. The harness manages them fully, without asking anyone: agents
restart their own editor with a tool, and a watch restarts a hung or crashed editor by itself.
Since w510 (2026-10-06) every editor is a machine daemon's, BEAST's included; the portal runs none and has no editor
watch of its own. The dialog watchdog (modal dialogs, recovery prompts) is separate: [unity-dialogs.md](unity-dialogs.md).

## Tools

| Who | Tool | Actions |
|---|---|---|
| worker in a machine sandbox (a Mac, a Windows PC, BEAST) | `mcp__machine__unity` | `status`, `start`, `stop`, `restart` of its sandbox's editor; `force: true` kills a frozen editor at once; `clear_batch` ends the machine's orphaned or hung batch builds, and the asking worker's own stalled ones within 10-20 min ([below](#orphaned-and-hung-batch-builds-are-ended-w791)) |
| orchestrator | `unity` with `sandbox` (`<machine>/<name>`, or `machine` plus a bare name) | the same, and `log`; a machine alone (its main clone) is refused (w536) |

A normal stop asks the editor to quit, then kills it after 30 s. A forced one
kills at once. Both kill what the editor started and any crash reporter left open for the project
(`UnityBugReporter`, `UnityCrashHandler64`), then remove a stale `Temp/UnityLockfile`. Start picks a
fresh log name when the old log is still locked. Restarting is fine with unsaved scene changes.

In a machine sandbox (BEAST's included), workers must use the tool, never kill Unity by hand: other sandboxes' editors
and the live game run on the same machine (`server/guard.ts`). No agent works in a machine's main clone (w536), and
the daemon runs no editor or watch for it, and its owner's own editor there is the owner's to use, not a wall for
work: a request that explicitly asks for work in the clone carries a grant (orchestrators.md, "Work in a machine's main
clone"), and its worker saves the scenes, quits the editor through the bridge, backs up, fetches and checks out, and
reopens Unity, never asking the person (w935 and w936, Ben: "You can close Unity."; ff-agents `editor-ops`, "An editor
open on a project you must change is yours to close").

## Hang and crash detection

`server/unityHang.ts` holds the verdict (`editorVerdict`), used by the daemon's watch (`MacUnityWatch`,
`machine/unity.ts`; the portal's own copy of the watch is gone, w510). Signals:

- **Process**: the editor is gone without a stop we asked for, or Unity's bug reporter is open for
  the project. (`UnityCrashHandler64` alone is not evidence: it runs beside every Windows editor.)
- **Window** (not used now): Windows' "not responding" for the main window (`IsHungAppWindow`, from
  `scripts/unity-windows.ps1`). Only the portal's own watch passed it to `editorVerdict` (`notRespondingSince`); no
  daemon does, so on a Windows machine the "window not responding" rule below never fires.
- **MCP bridge**: a JSON `{"type":"ping"}` over the MCP-for-Unity socket (port from
  `~/.unity-mcp/unity-mcp-status-*.json`, matched by project path). The editor answers it from its
  main thread (`EditorApplication.update`), so a frozen editor cannot; the bridge's bare framed
  `ping` is answered by the socket thread and proves nothing. A silent bridge only counts once it
  has answered for that editor: an editor whose bridge was never reachable is not judged by it.
- **Log growth**: imports, compiles, test runs and builds all write to the editor log as they go.

An editor is **hung** only when it is silent on every channel for long:

| Rule | Value (`DEFAULT_HANG`, `server/unityHang.ts`; no config since w510) |
|---|---|
| window not responding AND log silent | 180 s (`notRespondingSeconds`; unused, see above) |
| bridge not answering AND log silent, not reloading | 10 min (`bridgeSilentMinutes`) |
| bridge says reloading (domain reload, compile) AND log silent 10 min | 45 min (`reloadingMinutes`) |
| starting, log silent | 15 min (`startupStallMinutes`), for an editor the watch started |

A long import, compile or test run keeps the log growing, so it is never killed. An idle editor's log can be silent for hours, so the log never proves a hang by itself: the bridge does, and only after a quick ping (8 s) and a long one (60 s) both fail, since a throttled editor answers late but a frozen one never. On a Mac a silent bridge counts for nothing while the display is asleep (`pmset displaysleepnow`, App Nap throttles everything), and App Nap is turned off for Unity (`defaults write <Unity's bundle id> NSAppSleepDisabled -bool YES`, when the daemon starts and before every launch; it applies from the editor's next launch). A modal dialog is
never a hang: it is the dialog watchdog's business (seen in the last 3 minutes).
The daemon looks at each editor every 30 s.

## Automatic restart

On a hang or crash, `MacUnityWatch` (the machine daemon, every 30 s; before w510 the portal's `SandboxManager.autoRestart` did the same for its own editors):

1. force-kills the editor and what it started, and its crash reporters. On a Mac, a game player (any `.app` other than Unity's, e.g. the host player launched from the editor), another project's editor, Unity Hub and node/claude are never part of that, nor what they started; the result names what was left running;
2. clears the stale lock;
3. starts the editor again; the dialog watchdog answers the recovery prompts as usual;
4. records it: a `[unity] machine <id>: …` message to the orchestrator and a host notification (the daemon's
   `unity_event`, `machines.unityEvent` in `server/index.ts`);
5. messages the sandbox's (or machine's) agents that were busy or active in the last 30 minutes: "Unity of your sandbox
   was restarted automatically at <time> …; re-pin it … and continue where you left off."

At most **3 automatic restarts per 30 minutes** per editor (fixed in `MacUnityWatch`, `machine/unity.ts`;
restarts asked for with the tool do not count). Past that the watch stops restarting it and the orchestrator is told
once per window ("leaving it for a person (the unity tool still restarts it)"). The portal's `unity.autoRestart`
config (`max`, `windowMinutes`, `enabled`) is retired.

On a Mac, the watch restarts an editor it did not launch only on a hang it can prove through the
bridge; an editor that disappears is restarted only with crash evidence (the bug reporter, or a
crash at the end of `~/Library/Logs/Unity/Editor.log`), never when someone quit Unity. It never
touches git.

## Config

None for the watch since w510. `unity.hang`, `unity.autoRestart`, `unity.watchdog`, `unity.editorPath` and
`unity.extraArgs` are retired keys (`RETIRED_CONFIG_KEYS`, `server/config.ts`): a config that sets them loads and
ignores them, and the portal names them once at startup and in `system_status`. What stays under `unity` is
`idleStopMinutes` (an editor whose sandbox has no agent activity for that long, and no agent mid-turn, is stopped; 120)
and `mcpServer`, which the portal hands to its own computer's daemon (`localDaemonExtras`, `server/machines.ts`); on
another machine they are `daemon.json`'s `sandboxIdleStopMinutes` and `unityMcpServer`.

The machines (Macs and Windows PCs, [machines.md](machines.md#windows-machines)) get the watch and the `unity` tool with the daemon: redeploy it (`add_machine`) after an
update. An older daemon ignores the `unity` message, and the tool times out with that advice.

Tests: `server/unityHang.test.ts` (verdicts, budget, a fake bridge), `server/macUnity.test.ts`
(the Mac stop/start/restart and the watch).

## Unity slots: every editor counts

**Why** (w469, Lothsahn on 2026-10-05: "Can we just account for every unity editor process that's running?" and "Can
we make batch builds count towards unity editors?"). LothDesktop reached 63 of 64 GB of RAM and 100% CPU with one
interactive editor and three `-batchmode` player builds (about 24.5 GB of Unity.exe and 21 GB of Burst's bcl.exe), while
its limit of 3 counted only the interactive editor.

**What counts** (`machine/unitySlots.ts`, `unityProcesses`). A machine's `max_unity` counts every top-level Unity editor
process running there, whoever started it: sandbox editors, a person's own editor (in their clone), `-batchmode`
builds and test runs, a second editor for a peer run, editors started by scripts (the nightly harness, ffmode, clone
tools). A Unity process is the Unity binary itself (Windows: image name `Unity.exe`; a Mac: a command line that starts
with `.../Unity.app/Contents/MacOS/Unity`), so a script whose arguments name Unity does not count. Not counted:
AssetImportWorkers (`-name AssetImportWorkerN`, `-parentPid`, or any Unity started by a Unity), bcl.exe,
Unity.ILPP.Runner, the shader compiler, Unity Hub, and built game players (FinalFactory.exe or .app), which are shown
beside the count ("2 game players (not counted)") because the RAM gate below already covers them: a player takes 2-3 GB,
a fifth of an editor with its build.

**How it is counted.** Each Unity process belongs to the slot holder whose process started it (its nearest ancestor that
holds or waits for a slot, or a project the request named), else to the sandbox whose project it has
open, else to nobody (started outside the gate: a person's own editor among them, w536). A holder counts its granted slots or its Unity processes, whichever is
more; a sandbox counts its editor from the moment it is starting; each process outside the gate counts one. So
"editors 4 of 3: 1 interactive, 3 batch" is the real load, and nothing more is granted while it is over.

**The gate.** An interactive editor goes through `unity start` as before; a start is refused while the machine is full
or launches wait ahead of it, with the counts and who holds the slots (a restart keeps the slot its editor had, so a
hung editor always comes back). Every other launch takes a slot through a mailbox the daemon arbitrates, the
**`unity-slot`** command (first on the PATH of every agent the daemon runs) or the game repo's
`scripts/unity_slot.py`, which its build and audit scripts call themselves:

```sh
unity-slot run [--count N] [--label "<what>"] [--project <path>]... [--timeout <min>] -- <command> [args...]
unity-slot acquire [--count N] [--label ...] [--ttl <min>]   # hold in the background, prints the id
unity-slot release <id>
unity-slot status
```

`run` waits its turn, runs the command and frees the slot when it ends (its exit code is passed on). Launches inside a
`run` pass straight through (`FF_UNITY_SLOT_HELD`), so a script that wraps itself does not ask twice. Without a slot
arbiter on the machine (no FF Factory daemon, or one from before w469) it runs at once and says so.

**A `run` dies with whatever started it** (w1874). On biscuit, 2026-10-23, a worker ended the background shell that ran a
build script; its `unity-slot run` (pid 2460427) got no signal, lived on under the user's systemd, and kept its hung batch
Unity (pid 2460462) holding a slot and the sandbox's Library. Now `run` looks every 2 s (`CALLER_WATCH_MS`) whether its
caller is still there (Linux: its parent pid read live from `/proc/self/stat`, since node's `process.ppid` is the value
at start; a Mac or Windows: whether the caller's pid is alive), and SIGTERM or SIGHUP ends the run too. Either way it
stops the command's whole tree: SIGTERM, then a hard stop 20 s later (`stopTree`; a hung Unity ignores the polite signal).
So `nohup unity-slot run … &` from a shell that then exits is not a way to keep a build going: the run ends with its
caller. A run also records its agent's session (`FF_SESSION_ID`) in its request file, which tells the reaper whose build
it is (below). Tests: `server/unitySlots.test.ts` (`callerGone`, a real wrapper whose caller is SIGKILLed ends its command,
`runsIn`).

**The queue** (`assess`):

- **All or nothing.** A request takes all its slots at once or none. A peer run that needs two editors asks for 2.
- **Holders first.** When slots free, waiting requests from holders (a sandbox whose editor runs, a run that already
  holds slots; agents in a sandbox carry `FF_UNITY_HOLDER=sandbox:<id>`) go first, then new requesters, oldest first in
  each. A sandbox whose editor was stopped with the tool in the last 5 minutes keeps a holder's turn, so a worker that
  stops its editor to build its own project in batch mode is not sent to the back. The first that does not fit stops
  the queue, so singles never starve a peer run waiting for two.
- **No deadlock.** A waiter that holds slots (its own process's, or its sandbox's open editor) and asks for more than the
  limit leaves it is refused at once ("ask for all N at once"). When every slot in use is held by waiters, nothing would
  ever free one: a later waiter that fits goes first (it can finish), and if none fits the newest waiting holder is
  refused, so two runs never each hold part of what they need and wait forever (tested: two 2-editor peer runs on a
  limit of 3, all at once and one editor at a time).
- **Stuck or crashed holders.** A waiter or holder whose process is gone, or whose request file was not touched for 90
  s (the client touches it every 15 s), is freed at once and the orchestrator told. A waiter that has held slots while
  waiting for 30 minutes is refused. `acquire` holds for at most its `--ttl` (120 min). A waiter still alive whose
  request was dropped that way (suspended, then resumed) files it again under its first time and keeps its place; before
  this it waited silently for a grant that could not come (LothDesktop, 2026-10-07: a `run` waited 4 h).
- **RAM.** On a machine with `max_unity`, no slot is granted while RAM use is at 85% or more (`UNITY_RAM_PCT`, the
  placement's busy line), `unity start` included: one more editor takes 8-12 GB and a Burst build 4-10 GB more, about a
  quarter of 64 GB, and LothDesktop paged at 63 of 64. The queue waits; after 10 minutes on RAM the orchestrator is told.
  This host's own daemon's guard has a free-RAM gate on its editors too (`limits.minFreeRamGB`, 10 GB, handed to it by
the portal; `server/hostHealth.ts` `blockReason`).
- **The backstop.** Unity started outside the gate counts all the same. When the machine is over its limit the
  orchestrator is told once ("over its limit... Started outside the slot gate: batch FinalFactory"), and again when it is
  back. The backstop itself stops nothing; the reaper below ends a sandbox's orphaned or hung batch build.

**The mailbox** (`FF_UNITY_SLOTS`, which the daemon sets for its agents; else the folder a pointer
`~/.config/finalfactory/unity-slots.json` names, if a person wrote one (a worker-root install writes none: w513 keeps the
mailbox here too); else `~/.ff-factory/unity-slots`,
the same on every machine whatever its `app_dir`, so scripts find it with no config. Only the daemon's entry point
answers it: a `Daemon` built anywhere else, a test's, keeps its own under its `app_dir`): a client writes `req-<id>.json` (`pid`, `holder`, `count`, `label`, `projects`,
`createdAt`) and touches it while it waits or holds; the daemon answers `grant-<id>.json` or `deny-<id>.json` (`why`)
and keeps `arbiter.json` fresh (the counts line, who waits, who holds) every 15 s, every 5 s while anything waits or
holds. The daemon looks with the process listing its sandbox watch already makes (cached 5 s).

**Where it shows.** `list_sandboxes` (the machine's header and its Capacity line), `system_status` (each machine's
line), the dashboard's group header (`4/3 editors`) and `unity status` all say "editors 4 of 3: 1 interactive, 3 batch",
with what waits, the RAM line and the game players. A machine with no `max_unity` (no sandbox root) is counted and never
held up. Tests: `server/unitySlots.test.ts`, the w469 tests in `server/machineSandboxes.test.ts` and
`server/beastMachine.test.ts`.

## The bench queue: no build or boot beside a timed run (w1615)

**Why** (lothsahn, 2026-10-20: "a queued bench lock that also covers builds"; "Make sure the locking scheme you build
can't deadlock"). On BEAST a player build ran beside a held bench lock and its holder's quiet gate never passed, a worker
took over a live 40-minute-old lock, and waiters polled with no order.

**Turn limits** (w1832, enforced by the queue itself, `bench_queue.py` `Queue._enforce_limits`, "TURN LIMITS"; lothsahn,
2026-10-23: "The harness should let workers run with the exclusive lock for at most 30 minutes. They should get a warning
at 25 minutes"; "Both preemptions should be controlled in the worker harness, not in memory, and should not occur if
there's no other workers waiting in line"; "When exclusive lock work shows up, it should get scheduled 1 hour after the
last shared lock work started... And if that was a long time ago, all workers should always get a 5 minute warning"):

- An exclusive turn lasts 30 minutes while another worker's ticket waits behind it; with nobody waiting it goes on. A
  waiter arriving past the 30 minutes gives it 5 more. Once a timed leg waits, the running shared group ends an hour after
  its newest ticket started (5 minutes from then at the soonest). A worker's own waiting ticket never ends its own turn.
- Every holder is warned 5 minutes before: its helper prints it in the holder's command output, and the daemon reports it
  with its stats (`machine/benchWarnings.ts`, `benchWarnings`) so the portal messages the worker once per deadline
  (`server/benchWarnings.ts`), with its checkout's uncommitted files and unpushed commits and the ask to commit and push
  its work-in-progress branch now (lothsahn: "Workers should be encouraged to push their uncommitted work at the warning
  threshold so they can be scheduled on other machines"). At the deadline the ticket is revoked and the script, command
  and players under it are stopped; a re-request goes to the back of the queue. A waiter that leaves drops the deadline.
- **The priority hold** (w1860; lothsahn, 2026-10-23: "If a higher priority job holds the lock and all jobs below it are
  lower priority, it should retain the lock until done. If this is a shared lock, existing shared lock jobs should join it
  directly instead of queuing behind the exclusive lock"). Only a waiter of the same or higher request priority than the
  holder counts above. A shared group's priority is its highest running ticket's (`bench_queue.py` `group_rank`). With
  only lower-priority work waiting, the holder keeps the lock until it lets go: no deadline, no warning, no revoke, and
  its ticket folder's `keep.json` says so. A same-or-higher waiter seen later sets the deadline from then by the rules
  above, warning first. While a shared group runs, a new shared ticket joins it past waiting exclusive tickets ranked
  below the group and not above itself (`_join_running_group`); one of the group's priority or higher keeps the order.
  The machine view shows a kept holder as "keeps the lock: only lower-priority work waits" with no countdown, the next
  timed leg as starting "when the higher-priority work lets go" (`machine/benchState.ts` `keeps`,
  `shared/benchGlance.ts`), and the turn's messages say "when it lets go" for it, not "by HH:MM at the latest"
  (`machine/benchLock.ts` `holdEnds`, timedHolder `kept`).
- Exempt, by marks only the portal writes in `priorities.json` (`BenchPriority.exempt`, `Agents.benchPriorities`): the
  urgent release lane's builder (`release`, `BuildPlans.releaseBuilder`) and the scheduled nightly's worker (`nightly`, a
  request of source kind `nightly-run`). A machine whose agent cap is 1 (`Machines.singleWorker`, `agentCap`; lothsahn:
  "If a machine has only one worker it always runs in exclusive mode and never gets preempted", "I mean a machine that
  only hosts a single worker") gets `single_worker` and no limits at all. The file carries `v: 2`; a queue reading an
  older daemon's file honours a pre-empt ticket as before.
- An urgent release warns every holder, the nightly included (lothsahn: "Yes, an urgent release kicks the nightly off
  too; it reruns later"), takes them off 5 minutes later, goes ahead of the whole queue and has no cap.
- Exclusive only for exact timings or the whole machine (lothsahn: "request an exclusive lock if and only if they need
  the machine or exact timings. Otherwise they should use a shared lock"): an exclusive ticket names its reason
  (`bench_lock --timing|--machine`, `--reason`, `unity-slot run --bench exclusive --bench-reason`); shared is the default.

The queue is the game repo's `scripts/bench/bench_queue.py` (its `Documentation/Bench-Lock.md` has the design, the
deadlock rules and a test per case). A timed bench leg takes an `exclusive` ticket; a build, a batch compile or an
editor boot a `shared` one, which runs beside other shared ones but never beside an exclusive one. The order (w1628):
by the worker's request priority first (the daemon writes `bench.queue/priorities.json` from the portal's
`bench_priorities`, each minute), then one exclusive ticket, then the waiting shared group, and so on; a new shared ticket
joins the waiting group or goes right after the next exclusive one. The daemon reports the timed legs in the queue, running
or waiting (`readBenchQueue`, `MachineStats.benchQueue`): a release build goes to another computer meanwhile. Editor-gate
tickets carry the worker's `FF_SESSION_ID`, so they queue at its priority.

**A shared ticket waits for one exclusive turn at most** (w1962, lothsahn: "a shared bench-queue ticket (an editor start,
a build) must not wait for hours behind one exclusive timed ticket after another"). The game repo's `bench_queue.py`
does it since its `RULES_VERSION` 1, but each ticket's helper decides under its own branch's copy, and a branch from before
it keeps the old order: a higher priority goes first, and an urgent holder keeps the lock while only lower-priority work
waits (w1860). So the daemon also does it through what every copy reads at every decision, `priorities.json`
(`machine/benchRaise.ts`, every 5 s): a waiting shared ticket that an exclusive turn has passed (one held the lock while it
waited), or that an exclusive ticket taken after it outranks (on LothDesktop on 2026-10-24 a normal build waited behind
w1789's later high leg, which itself waited behind a shared group kept urgent by game players, with no exclusive holder),
has its session raised to `urgent` while it waits (`raisedFrom`, `raisedFor`; the marks are kept in the file's
`passed`). It then sorts before the exclusive tickets taken after it, and counts against the holder, whose 30-minute
turn (w1832) ends instead of the hold. A session with a live exclusive ticket of its own is not raised (its timed leg
would move up too). An editor start's ticket has a session of its own, `editor:<sandbox>` (`FF_BENCH_SESSION`), at the
highest priority of the workers in that sandbox. The exclusive guarantee does not change: a raised ticket still waits
for the holder to go. FF Factory takes tickets in three places (`machine/benchQueue.ts` runs the game repo's helper as a child, since
node cannot take the OS file locks the queue lives on):

- **`unity-slot run`** takes a shared ticket after its Unity slots (`--bench exclusive`, or `FF_UNITY_SLOT_BENCH`, for a
  timed run). A run made inside a bench hold (`FF_BENCH_TICKET`) reuses it, and waits for a slot at most 2 minutes.
- **`unity start`** of a sandbox editor checks the slot first, then takes a shared ticket. Not granted within 5 s, it
  answers `Queued (w1615)` and the pool starts the editor itself at its turn, checking the gates again but not the slot
  it already holds (w1962: a queued start counts in the slot count, so a second check counted it twice); `unity status` shows its place. A stop cancels a queued start.
  Since w1860 (lothsahn, 2026-10-23: "builds or any compute intensive job needs a lock"; yes to "running editors and game
  players hold a shared ticket while they run") the ticket, `running editor <sandbox>`, is held for as long as the editor
  runs, not only while it boots, and goes once the editor is gone. A running editor that lost its ticket (revoked at
  the shared group's limit, its helper gone) or never had one (adopted, the queue unreachable at its start) takes a new
  one within a minute (`EDITOR_TICKET_RETRY_MS`) and runs on meanwhile. The game repo's `bench_queue.py` lets the
  editor's ticket of a timed leg's own sandbox ride along with it (`rides_along`); every other sandbox's editor holds a
  timed leg back to the shared group's hour, warning first, and the exclusive turn below then closes it. So the machine
  view's Free means nothing runs. Game players hold one too, for their whole life (the game repo's
  `player_slots.py launch`, `hold_player_ticket`).
  The sandbox shows `starting`, not `running`, until this editor's own bridge wrote its
  `~/.unity-mcp/unity-mcp-status-*.json` after it was launched (`server/unityHang.ts` `bridgeUpSince`, w1829): the port
  file outlives every editor, so before this a booting editor showed `running` ("MCP bridge up") at the pool's first
  look, 12 s into a 199 s first import on BEAST's slot5, and its boot ticket went then too.
- **`readBenchLock`** (`machine/benchLock.ts`): a holder whose owner line names a ticket (`[t00000042]`) counts while
  its helper process lives, however old; an old-style line keeps the 40-minute rule.

- **The sandbox editor's own compiles, imports and test runs** (w1628, `machine/editorBenchGate.ts`; lothsahn: "Won't
  builds use a ton of cpu and invalidate runs?"). A Unity MCP call that compiles, imports or runs tests (`refresh_unity`,
  `run_tests`, `execute_menu_item`, the script and asset edits) first takes a shared ticket for the sandbox's editor and
  waits for it up to 150 s inside the call (its hook matcher allows 180 s). Not granted by then, the call is refused with
  `Queued (w1628)` and its place in line, which is kept 30 minutes for the call made again. The ticket stays while the
  session keeps using its editor and goes 5 minutes after its last Unity MCP call (2 minutes when its turn came and no
  call used it). One gate per sandbox per process: a sandbox's agents share one editor.
- **A batch Unity started straight from the shell** (`Unity -batchmode ...`, `"$UNITY" -batchmode ...`) is refused by
  the guard (`checkRawUnityBatch`, w1628) with the `unity-slot run` command to use instead, which takes a slot and a
  ticket. So is an editor opened on a project straight from the shell (`Unity -projectPath ...`, w1860): `mcp__machine__unity`
  start, or `unity-slot run` for a peer run's second editor.
- **The census** (`server/benchLaunchCensus.test.ts`, w1860; lothsahn: "Please make sure every build or CPU intensive
  job scheduled by the portal takes a lock. Shared unless it's a performance sensitive job like a timing run") lists
  every place FF Factory's own code starts a Unity or a game player, with the ticket it holds (today one: the sandbox
  editor, `machine/unity.ts`). A new launch path fails it until it is listed with its ticket. Workers start everything
  else through the game repo's launchers, each with its ticket: `unity-slot run` / `ff_unity_slot` / `unity_slot.py run`
  / `build_player.sh` (shared; exclusive for a timed run), `player_slots.py launch` (shared, the player's life),
  `quiet_gate.sh bench_lock` (exclusive), the nightly (`ffnightly.py --lock-night`, one shared ticket for the night) and
  `urgent_release.py` (exclusive, pre-empting).

A checkout without `bench_queue.py` (a branch from before w1615) takes its ticket with another sandbox's copy of the
script (`sandboxBenchQueueScript`, w1628: the queue is its files, not its code); with none on the machine, or without
python, a sandbox editor goes ahead without a ticket and logs why (it takes one within a minute once it can), while
`unity-slot run` does not start: a run whose helper fails or whose ticket the queue refuses exits 69, or 77 for an
exclusive ticket on a machine that takes no timed runs (w1861), with the reason, and never runs without a ticket
(w1860: it used to).

**Not covered by the tickets alone** (w1628): an editor's own refresh when its window gets focus (Unity's Auto Refresh),
play mode started from the editor, and an editor or player that was already running. The exclusive turn below closes them.

## The exclusive turn: nothing else runs beside a timed run (w1829)

**Why** (lothsahn, 2026-10-23: "When the exclusive lock is held, only that worker should be running. Players, editors, and
other work should shutdown to allow for proper timing"; "The locking should be a positive control that manages the worker
and it's slots"). The tickets kept new builds, boots, compiles and tests out of a timed leg, but editors already open in
other sandboxes kept going: on LothDesktop, w1785's legs (worker dec9a619) saw two of them use 5.9 and 2.7 cores, so the
game repo's `quiet` gate never opened, workers timed with `NOGATE=1`, and one Just Play exe measured 27.4 fps quiet and 12
to 15 fps busy.

**What** (`machine/benchTurn.ts` `BenchTurn`, the daemon looks every 5 s). While a granted, unrevoked exclusive ticket whose
helper lives holds the machine (`machine/benchLock.ts` `timedHolder`; past its 30-minute turn too while nobody waits,
w1832), the daemon:

- **closes every other sandbox's editor** that is up, the way an idle Live view's closes (`machine/liveIdle.ts`
  `idleCloseEditor`, w1746): it leaves play mode, saves the open scenes and the assets through the editor, then quits it.
  One that compiles or imports, or has an untitled scene with unsaved changes, is left and tried again every 30 s; one
  that took the quit and still runs 15 s later (an unfocused, idle editor does not update, so its delayed quit waits:
  w1829, BEAST 2026-10-24, marked closed at 03:06Z, quit at 03:15Z) is asked again to quit inside the bridge's own call
  (`EXIT_NOW_SNIPPET`, docs/live-view.md "Idle editors close"); one that does not quit is left running. Nothing is killed, and the editor watch never takes an editor it told to quit for
  hung while it goes quiet (`machine/unity.ts` `expectExit`, kept per editor pid). One that comes up during the turn (a
  start that did not queue) is closed too. The sandbox is marked (`benchClosed` in `sandboxes.json`, with the ticket and
  the editor's pids) before the quit is sent, and its line in `list_sandboxes`, `unity status` and the sandbox panel says
  `closed for a timed run on <machine>/<sandbox> (<request>); reopens when it ends (by HH:MMZ at the latest)`.
- **asks every other worker's game player to quit**, the way a person closes it: `taskkill /PID` without `/F` on
  Windows (its window's close; a window-less player cannot be asked and is left), SIGTERM elsewhere. A single-player
  game normally saves as it quits (the game repo's `SaveGameManager.WaitForSaveBeforeQuit`); a multiplayer game and an
  automation run (`-ffAutomationRole`) do not (`QuitAutosave.Decide`), so the worker is told the test it was part of is
  void. One still running is asked again after 2 minutes, never forced. A player is a worker's when it has a player
  slot or a worker session (`machine/leftovers.ts`); a person's own game has neither and is left. Each pid is checked
  in a fresh process listing right before it is asked (the leftovers' list can be a minute old). A holder with no
  worker session (a person's own timed run) asks no player to quit: the bench scripts start the measured player with
  `--detach`, so it has no parent to tell it from the others by.
- **refuses Unity MCP calls into a closed editor** (the guard, `benchClosed`, from `<root>/tmp/bench.queue/closed.json`)
  with why and when it comes back, so a worker mid-turn knows instead of waiting on a bridge that is gone. Its shell and
  other tools keep running. A worker whose player was asked to quit, or whose editor came back, hears it at the start of
  its next message (`[bench turn] ...`).
- **stops every other sandbox's batch Unity** (w1860; lothsahn, 2026-10-23: "Make the shutdown of builds for the
  exclusive lock urgent"): a player build, a test run or a batch compile whose `-projectPath` is one of the daemon's
  sandboxes. None of them can hold a ticket beside the turn (a shared ticket waits for an exclusive one), so one that
  runs has none: it started without a ticket, or its ticket was revoked (the shared group's limit, an urgent release)
  and it went on. A batch Unity has no window and nothing unsaved, so it is not asked: its tree is ended the way a stuck
  build is (`UnityReaper.endBatch`, children first, then the stale `Temp/UnityLockfile`), the orchestrator hears it, and
  the sandbox's workers hear at their next message to run it again under `unity-slot run`. The worktree's files are not
  touched. Looked for at the grant, then every 30 s (`BUILD_LOOK_MS`: the process listing costs CPU the run measures).
  Left: the holder's sandbox and its owner's tree, an exempt worker's sandbox (the urgent release builder, the nightly:
  `BenchPriority.exempt`), and a Unity whose project is no sandbox (the main clone, a person's own).
- **holds the rest as before**: `unity start` queues (a shared ticket), builds, batch compiles and the editor's compiles,
  imports and tests wait for their shared turn, and the guard refuses new players and screen grabs (w1750).
  `unity-slot run` with no ticket of its own (`FF_BENCH_TICKETS=off`; one that cannot be taken stops the run) waits for another worker's
  timed run to end before it starts (`foreignTimedHold`, w1860), and a run whose ticket is revoked under it ends its
  command (SIGTERM to the tree, a hard stop 20 s later; `taskkill /T /F` on Windows) and exits 75: its helper is a
  service owner that stops nothing itself, and until w1860 the build went on beside the timed run granted next.

Never touched: the holder's own sandbox (its ticket's `FF_SANDBOX_ID`), any process under the ticket's owner (its
script's peer editor or player), its session's players, an editor the pool does not own (a person's own project, the
main clone) and a player with no slot or session.

**After the turn.** When the ticket goes (released, its holder killed, which ends its helper within a second or two,
revoked at its turn's deadline once a worker waits (w1832), or the next exclusive ticket granted before a look saw the lock free), every editor it closed starts
again with `unity start`: it takes a shared ticket, so it comes back in the next shared turn, never beside the next
timed leg, and the panel shows its place. The holder's own sandbox is never kept closed for its own run. The mark stays
until the editor runs again, so a start that fails or is not made at its turn (no Unity slot, low disk) is asked for
again every 30 s; after 3 starts that never ran (an editor that crashes at boot) it is left stopped and its worker told.
A `unity stop` asked for is the last word: the turn does not start that editor again. An editor still quitting under
the turn keeps its mark and is not closed a second time. The marks survive a daemon restart, which reopens them at its
first look.

**Keep the turn short.** Every other sandbox's editor closes and reopens around each exclusive ticket, so a timed leg
takes it only around the timing itself: build, stage and warm up under a shared ticket (or none), take the exclusive
one right before the measured part, and give it back as soon as the numbers are written. The queue alternates on a busy
machine (one exclusive ticket, then the waiting shared group, within a priority; the game repo's
`scripts/tests/test_bench_queue_order.py`), and the editors closed for one ticket come back in the shared turn after it, so a long A/B of many short tickets interleaves with the others' work.

Tests: `server/benchTurn.test.ts`, `server/benchBuilds.test.ts` (w1860), the w1829 cases in
`server/machineSandboxes.test.ts` and `server/macUnity.test.ts`.

## A person's game: the agents yield while a person plays (w1894)

**Why** (item 1 of w1785's ranked list, filed for lothsahn: "Please file all of w1785s ranked list"). On LothDesktop one
release build of the game ran at 27.4 fps on a quiet machine and at 12 to 15 fps while agents' players, editors and builds
held 7.5 to 11.3 of its 16 threads (measured by w1785). Goal: while lothsahn plays there, the agents stop taking the game's
CPU, and resume when the game stops.

**How a person's game is told from an agent's** (`machine/leftovers.ts` `personGames`, fed to `machine/personPlay.ts`
`PersonPlay` by each leftovers look, once a minute). Every game player the look sees (`gamePlayers`: FinalFactory.exe and
its Mac and Linux twins) is a worker's when it carries `FF_SESSION_ID` in its environment (every worker shell and what it
starts does), has a player slot lease for its pid (`player_slots.py launch`), or its command line names a worker's temp
folder or a sandbox (a build an agent runs from there; a sandbox editor's Build And Run). The rest is a person's: Steam's
launch of the game, or a build someone starts by hand, a slot player started by hand without a lease included (the
reaper no longer counts that one an orphan to end where this is on). The game window in front was weighed and not used:
a person alt-tabs to a guide or Discord while the game runs and still wants its frames, and an agent's player in front
would count as the person's.

**What the agents do meanwhile.** The game holds an exclusive turn (`machine/benchTurn.ts`, `Holder.person`, the
daemon's `personHolder`) with no queue ticket, and the turn does what a timed run's does, with one difference:

- every sandbox's editor closes (saved first, never killed; "The exclusive turn" above), every worker's game player is
  asked to quit (its window's close), and Unity MCP calls into a closed editor are refused with who plays and when it
  comes back;
- a batch Unity (a build, a test run, a batch compile) is **dropped to idle priority and left to finish**, never ended:
  it holds its shared ticket rightfully, since no exclusive ticket is in the queue. The daemon sets the idle class on its
  tree at the turn's first look and every 30 s after (Windows: `PRIORITY_LOW` is `IDLE_PRIORITY_CLASS`, which the
  processes it starts later inherit) and its workers hear it once;
- nothing new starts: `unity start` is refused (the pool's `startGate`), `unity-slot run` waits before it takes a slot or
  a ticket (`personHoldReason`), the guard refuses a game player (by its binary or `player_slots.py launch`) and a screen
  grab (`checkPersonPlayLaunch`), and the portal sends `no_timed_runs` so the bench queue grants no timed leg there; a
  timed leg already running finishes its turn, which closes nothing new;
- the portal places no new work there (`Agents.placement()`, `playHolds` in `shared/personPlay.ts`): the Capacity block
  reads `ROOM n% but HELD (lothsahn is playing Final Factory there since 19:00Z (w1894: agents yield there until 10 min
  after the game closes))`. The workers already there resume as before: their shells, git and reasoning go on, and only
  their Unity work waits.

Why close and not only idle priority for editors and players: a lower priority leaves them the GPU (LothDesktop's Arc
B580 renders an editor in play mode and every player beside the game) and the CPU's shared cache, which the game's
simulation lives in on its 5800X3D. That is a guess, not a measurement (w1894's A/B on BEAST was stopped before its first
leg, so as not to hold an exclusive ticket there for harness work); w1829 chose closing for timed runs on the same grounds.
The live check on LothDesktop measures the result.

**The grace** (`GRACE_MIN`, config `machines.personPlay.graceMinutes`, default 10, a guess): the turn lasts until 10 minutes
after the game is first seen gone, so a restart of the game (a crash, a settings change, quitting to load another save)
keeps it one turn. Then the editors reopen in the next shared turn, the idle-priority builds go back to normal
(`restoreBuilds`: every sandbox batch Unity process at `PRIORITY_LOW`), and the hold lifts.

**Nothing left stuck.** No process is suspended. The state is `<root>/tmp/bench.queue/person.json`, written at every look:
the guard and `unity-slot run` hold only while it is fresh (`STALE_MS`, 5 minutes), so a daemon that is gone holds
nothing. A daemon restart keeps a game seen just before it until its first look, reopens the editors marked closed
(`benchClosed` in `sandboxes.json`, as after a timed run) and puts back to normal any build left at idle priority, at its
first look. The portal's hold reads the daemon's stats (`MachineStats.personPlay`) and drops them when they are 3 minutes old
(`PERSON_PLAY_STALE_MS`) or the machine is offline.

**Where it is on** (config `machines.personPlay`, set with `set_app_config`, optional `machine`): `enabled` (default on at
LothDesktop only, `PERSON_PLAY_DEFAULTS`: BEAST runs most of the agents, and a game started there for a test would close
every editor on it), `graceMinutes`, and `who`, the name the messages use (default lothsahn at LothDesktop, else
"someone"). The portal sends it with the bench priorities each minute; the daemon keeps it in `<app_dir>/person-play.json`.
It needs the leftovers look (`daemon.json` `leftovers` not false).

**Where it shows**: `list_machines` (`playing: …`, with the editors closed, players asked to quit and builds at idle
priority), the Capacity block's `HELD (…)` (above), the machine page (an amber **Playing** state and row), the sandbox
panel and `unity status` of each closed editor ("closed while lothsahn playing Final Factory on this PC; reopens when that
ends, 10 min after the game closes"), and the portal journal (`portal_logs` grep "is playing Final Factory").

**Checking it without a person.** Start a slot player with no worker in it: no `FF_SESSION_ID`, `FF_SANDBOX_ID` or
`FF_MACHINE_ID` in its environment, not through `player_slots.py` (no lease), and no temp folder in its arguments (no
`-logFile` there: the game writes its own Player.log), from your own sandbox's slot. A slot path keeps the Windows Firewall rule the install made for it; a new exe path raises the
firewall prompt.

Tests: `server/personPlay.test.ts`, the w1894 case in `server/leftovers.test.ts`.

## Orphaned and hung batch builds are ended (w791)

**Why** (Ben, 2026-10-09: the harness learns from a repeated problem). Twice that day a sandbox's `-batchmode` build held a
Unity slot for hours until a person approved killing it by hand through the ops worker, and workers may not kill Unity
(`server/guard.ts`): LothDesktop pid 3856, a nightly prepare build of slot4 that hung for 3 h 29 min on "More than one copy
of bee_backend running in slot4" with its script still alive (the log stopped; `.nightly-builds/<sha>-win/build-manifest.json`
says `prepare-failed`, 209 min), and m5 pid 81390, a worker's `BuildMacMultiplayerDev`, 15 h old, parent pid 1.

**What** (`machine/unityReaper.ts`, `UnityReaper`; the daemon looks once a minute and on request). Only a top-level
`-batchmode` Unity whose `-projectPath` is one of the daemon's sandboxes is ever judged: never an interactive editor (the
`unity` tool and the watch own those), never the main clone or a person's own checkout. Per build the reaper reads its start
time and its tree's CPU time (CIM on Windows, `ps -o etime,time` on a Mac and Linux) and the write time of its `-logFile`
(none when the log is stdout), and counts **progress** as the log growing or the tree using CPU at 10% of one core or more
between looks (`CPU_BUSY_SHARE`; a long Burst compile is silent in the log but busy). The owner is the build's parent process:
gone when its pid is missing from the listing (Windows keeps a dead parent's pid), when it is launchd/init/a user's systemd
(pid 1), or when a process with that pid started after the build did (a reused pid). When the parent is a `unity-slot run`
wrapper (the daemon's `unitySlots.ts run` or the game repo's `unity_slot.py run`), the owner is the wrapper's own parent
(w1874): a wrapper left under init with nobody makes its build an orphan.

| The build | Ended when |
|---|---|
| owner gone (seen by two looks in a row) | no progress for 10 min, or running 90 min whatever it does |
| owner alive | running 60 min and no progress for 30 min |
| owner alive, only the log is silent | running 6 h and the log silent for 30 min (a hang that burns CPU) |
| the asker's own (`clear_batch`, w1874), whatever its age or owner | log silent for 20 min, or no progress (log and CPU) for 10 min |

Anything else is kept, and the report says why. Ending a build kills its tree (children first, with what an editor restart
spares: game players, another project's editor, Unity Hub, node/claude), removes the sandbox's `Temp/UnityLockfile` when no Unity
still has the project open, ends a `unity-slot run` wrapper still there whose caller is gone (one whose caller is alive
ends by itself and tells its caller the exit), looks at the slots again at once (the dead owner's request is freed by the arbiter already, so
the next waiting launch is granted), logs `unity reaper: ended batch Unity pid …` and tells the orchestrator
(`Unity batch build: …`).

**Where the numbers come from.** Measured: 15 healthy nightly Windows builds on LothDesktop (2026-10-07..09, started..finished
in their `build-manifest.json`) took 4.5 to 36.9 min, median 8.4; the hung one ran 209 min. 60 min is 1.6x the longest healthy
one. The stall windows (30 min, 10 min for an orphan), the 90 min and 6 h ceilings and the 2 s of CPU are guesses on top of
that measurement, chosen wide; the owner test (parent gone) is sourced from how Windows and POSIX report a dead parent (a
dead parent's pid stays in `ParentProcessId`; a POSIX child is re-parented to pid 1 or a user's systemd). All of them are in
`REAP` and the table above. A daemon restart forgets what it saw, which only delays a kill (progress counts from first sight). Builds are told apart by pid and command line (w1196): a Mac's and Linux's start time is now minus `ps`'s elapsed seconds and moved by up to a second between looks (715 ms measured on biscuit), so until w1196 no build there was ever seen by two looks and none was ended.

**Why 2 s of CPU became 10% of a core** (w1874, measured). biscuit pid 2460462, hung in a futex wait after "Unloading 192
Unused Serialized files" (its log silent from 09:51:30), used 50-80 ms of CPU a minute across its tree (sampled 10:20-10:23),
yet `clear_batch` said "last progress 3 min ago" at 10:10 and "12 min ago" at 10:20 with the daemon up since 09:49: one burst
of 2 s or more around 10:07 restarted its stall clock. (`ps` showed it at "~3% CPU": that is its lifetime average, mostly
its start, not what it used while hung.) That a working build's silent phases keep a core busy is a guess.

**A worker that waits** on a slot a stuck build holds calls `mcp__machine__unity` with `action: "clear_batch"`: the same look
at once, for the whole machine, answered with what was ended or, for every build kept, why (no limit is lowered on request).
**Its own builds go by the owner rules** (w1874; lothsahn: jobs that hang or jam should be unjammed). The portal sends the
asking worker's session with the action, and a build is the asker's when the `unity-slot run` above it recorded that session,
or recorded none (a wrapper from before w1874, the game repo's `unity_slot.py`, no wrapper) and the build is of the asker's
sandbox. A build another session started stays under the rules above, as does every build when the orchestrator asks. The
asker's own build is ended once its log has been silent for 20 min (`OWNED_LOG_STALL_MS`), or log and CPU for 10 min
(`OWNED_STALL_MS`). Measured: of 690 healthy batch build logs on biscuit (2026-10-14..23, every `-logFile` under the sandboxes
and temp folders that ended in success), the longest silence was 592 s, Bee's `GenerateNativePluginsForAssemblies` (Burst AOT
of the player) printing nothing between `[497/500 10s]` and `[498/500 602s]`; next 469 s (the same step) and 266 s
(`BuildPlayerDataGenerator`). Unity's log has no clock, so Bee's own clock in its progress lines bounds each silence. 10 min
of silent log with an idle tree is past that, and a Burst step keeps its CPU busy; 20 min (2x) covers a slower machine's Burst
and a hang that spins. The log rule reads the log's write time, so a daemon restart does not delay it; the 10 min rule counts
from the daemon's first sight. Windows and Mac build logs were not measured (none on biscuit).
Daemons of protocol 9 and later (`BATCH_CLEAR_PROTOCOL`); the portal refuses it for an older one, which would take an unknown
action for a start of the editor. Tests: `server/unityReaper.test.ts` (the two cases of 2026-10-09 end; an interactive editor,
a non-sandbox project, an alive and progressing owner, a busy-but-silent build, a young build and a progressing orphan stay;
the w1874 biscuit case: an orphaned wrapper's build, idle with a 2.5 s burst, ends at 10 min with its wrapper; its owner ends
it at once, another session cannot; an owned busy build stays to 20 min, an owned idle one goes at 10), and
`machineSandboxes.test.ts` (the tool reaches the daemon).

## Each sandbox's Unity MCP reaches only its editor

MCP-for-Unity (stdio) finds editors through the status files every editor writes to `~/.unity-mcp`.
Pinned (`set_active_instance`) to an editor it can no longer find, because it is restarting, reloading
or has crashed, it reconnects to whatever discovery finds next: the newest status file, the newest
port file, or port 6400. That is another sandbox's editor, or the live game's. The pin itself is per
server process (its `session_key: global` is only the in-process key), so the leak was the fallback.

So each sandbox's workers run their `UnityMCP` server with `UNITY_MCP_STATUS_DIR` set to a folder of
their own, `<app_dir>/unity-mcp/<sandbox>` on the machine (`machine/unityMcp.ts`, `scopedUnityMcp`). The daemon
(every 5 s, `McpScopes`, `syncStatusDir` in `server/unityMcp.ts`) keeps in it only that sandbox's editor's
status file, while its process is alive and only if the file was written since that editor was
launched: a crashed editor's leftover file may name a port another editor has taken since. It also
writes the legacy `unity-mcp-port.json` there with the editor's own port, or 0 while it is down, so the
fallback's last step never reaches port 6400. `mcpforunity://instances` lists only the sandbox's own
editor, and a call made while it is down fails instead of landing elsewhere. Editors keep writing to
`~/.unity-mcp`, so this needs no editor restart, and the hang detection is unchanged. The guard still
refuses Unity MCP calls until the worker pins its own `<sandbox>@<hash>`.

An agent outside a sandbox (a standing agent) gets no UnityMCP (w536, [machines.md](machines.md)). Not
covered: Claude Code sessions outside FF Factory.
