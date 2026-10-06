# Unity editor lifecycle: start, stop, restart, hang and crash recovery

Unity editors crash and freeze often. The harness manages them fully, without asking anyone: agents
restart their own editor with a tool, and a watch restarts a hung or crashed editor by itself.
The dialog watchdog (modal dialogs, recovery prompts) is separate: [unity-dialogs.md](unity-dialogs.md).

## Tools

| Who | Tool | Actions |
|---|---|---|
| sandbox worker (host) | `mcp__sandbox__unity` | `status`, `start`, `stop`, `restart`, `log`; `force: true` kills a frozen editor at once |
| machine worker (Mac or Windows PC) | `mcp__machine__unity` | `status`, `start`, `stop`, `restart` (`force` as above) |
| orchestrator | `unity` with `sandbox` or `machine` | the same; `log` is sandbox-only |

A normal stop asks the editor to quit, then kills it after 15 s (host) or 30 s (machine). A forced one
kills at once. Both kill what the editor started and any crash reporter left open for the project
(`UnityBugReporter`, `UnityCrashHandler64`), then remove a stale `Temp/UnityLockfile`. Start picks a
fresh log name when the old log is still locked. Restarting is fine with unsaved scene changes.

On the shared host, workers must use the tool, never kill Unity by hand: other sandboxes' editors
and the live game run on the same machine (`server/guard.ts`). On their own Mac, machine workers may
end and relaunch Unity however they like; the guard only protects the FF Factory daemon, the
agent's own `claude` process and Ben's working tree.

## Hang and crash detection

`server/unityHang.ts` holds the verdict (`editorVerdict`), shared by the host and the Mac daemon.
Signals:

- **Process**: the editor is gone without a stop we asked for, or Unity's bug reporter is open for
  the project. (`UnityCrashHandler64` alone is not evidence: it runs beside every Windows editor.)
- **Window** (host only): Windows' "not responding" for the main window (`IsHungAppWindow`, from
  `scripts/unity-windows.ps1`, probed every 60 s for running editors).
- **MCP bridge**: a JSON `{"type":"ping"}` over the MCP-for-Unity socket (port from
  `~/.unity-mcp/unity-mcp-status-*.json`, matched by project path). The editor answers it from its
  main thread (`EditorApplication.update`), so a frozen editor cannot; the bridge's bare framed
  `ping` is answered by the socket thread and proves nothing. A silent bridge only counts once it
  has answered for that editor: an editor whose bridge was never reachable is not judged by it.
- **Log growth**: imports, compiles, test runs and builds all write to the editor log as they go.

An editor is **hung** only when it is silent on every channel for long:

| Rule | Default (config) |
|---|---|
| window not responding AND log silent | 180 s (`unity.hang.notRespondingSeconds`) |
| bridge not answering AND log silent, not reloading | 10 min (`unity.hang.bridgeSilentMinutes`) |
| bridge says reloading (domain reload, compile) AND log silent 10 min | 45 min (`unity.hang.reloadingMinutes`) |
| starting, log silent | 15 min (`unity.hang.startupStallMinutes`, default `unity.watchdog.stallMinutes`) |

A long import, compile or test run keeps the log growing, so it is never killed. An idle editor's log can be silent for hours, so the log never proves a hang by itself: the bridge does, and only after a quick ping (8 s) and a long one (60 s) both fail, since a throttled editor answers late but a frozen one never. On a Mac a silent bridge counts for nothing while the display is asleep (`pmset displaysleepnow`, App Nap throttles everything), and App Nap is turned off for Unity (`defaults write <Unity's bundle id> NSAppSleepDisabled -bool YES`, when the daemon starts and before every launch; it applies from the editor's next launch). A modal dialog is
never a hang: it is the dialog watchdog's business (seen in the last 3 minutes).
The host checks each running editor every `unity.hang.checkSeconds` (30); a process listing, which
costs a few seconds, runs every 5 minutes, or at once when something already looks wrong.

## Automatic restart

On a hang or crash, `SandboxManager.autoRestart` (host) or `MacUnityWatch` (Mac daemon, every 30 s):

1. force-kills the editor and what it started, and its crash reporters. On a Mac, a game player (any `.app` other than Unity's, e.g. the host player launched from the editor), another project's editor, Unity Hub and node/claude are never part of that, nor what they started; the result names what was left running;
2. clears the stale lock (and, on the host, starts on a fresh log if the old one is locked);
3. starts the editor again; the dialog watchdog answers the recovery prompts as usual;
4. records it: on the sandbox card (`unity.restarts`, "Restarted after a hang or crash"), a
   `[unity]` notice to the user and the orchestrator, and host health (`unityRestarts`, the last
   hour, in `system_status`);
5. once the editor is running again, messages the sandbox's (or machine's) agents that were busy
   or active in the last 30 minutes: "Unity was restarted after a hang/crash at <time>; re-pin and
   continue."

At most **3 automatic restarts per 30 minutes** per editor (`unity.autoRestart.max`,
`windowMinutes`; restarts asked for with the tool do not count). Past that the harness stops: a
hung editor is marked blocked (`restart-limit`), a crashed one stays crashed, and the user and
orchestrator are told once. Restarting it with the tool clears the block. `unity.autoRestart.enabled:
false` turns automatic restarts off (a stalled start is then only reported, as before).

On a Mac, the watch restarts an editor it did not launch only on a hang it can prove through the
bridge; an editor that disappears is restarted only with crash evidence (the bug reporter, or a
crash at the end of `~/Library/Logs/Unity/Editor.log`), never when someone quit Unity. It never
touches git.

## Config

```json
"unity": {
  "hang": { "notRespondingSeconds": 180, "bridgeSilentMinutes": 10, "reloadingMinutes": 45, "startupStallMinutes": 15, "checkSeconds": 30 },
  "autoRestart": { "enabled": true, "max": 3, "windowMinutes": 30 }
}
```

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
process running there, whoever started it: sandbox editors, the main clone's or its owner's own editor, `-batchmode`
builds and test runs, a second editor for a peer run, editors started by scripts (the nightly harness, ffmode, clone
tools). A Unity process is the Unity binary itself (Windows: image name `Unity.exe`; a Mac: a command line that starts
with `.../Unity.app/Contents/MacOS/Unity`), so a script whose arguments name Unity does not count. Not counted:
AssetImportWorkers (`-name AssetImportWorkerN`, `-parentPid`, or any Unity started by a Unity), bcl.exe,
Unity.ILPP.Runner, the shader compiler, Unity Hub, and built game players (FinalFactory.exe or .app), which are shown
beside the count ("2 game players (not counted)") because the RAM gate below already covers them: a player takes 2-3 GB,
a fifth of an editor with its build.

**How it is counted.** Each Unity process belongs to the slot holder whose process started it (its nearest ancestor that
holds or waits for a slot, or a project the request named), else to the sandbox or main clone whose project it has
open, else to nobody (started outside the gate). A holder counts its granted slots or its Unity processes, whichever is
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
  waiting for 30 minutes is refused. `acquire` holds for at most its `--ttl` (120 min).
- **RAM.** On a machine with `max_unity`, no slot is granted while RAM use is at 85% or more (`UNITY_RAM_PCT`, the
  placement's busy line), `unity start` included: one more editor takes 8-12 GB and a Burst build 4-10 GB more, about a
  quarter of 64 GB, and LothDesktop paged at 63 of 64. The queue waits; after 10 minutes on RAM the orchestrator is told.
  This host's own daemon already had the host guard's free-RAM gate on its editors (`limits.minFreeRamGB`, 10 GB).
- **The backstop.** Unity started outside the gate counts all the same. When the machine is over its limit the
  orchestrator is told once ("over its limit... Started outside the slot gate: batch FinalFactory"), and again when it is
  back. Nothing is ever stopped or killed.

**The mailbox** (`~/.ff-factory/unity-slots`, or `FF_UNITY_SLOTS`; the same on every machine whatever its `app_dir` or
worker root, so scripts find it with no config. Only the daemon's entry point answers it: a `Daemon` built anywhere
else, a test's, keeps its own under its `app_dir`): a client writes `req-<id>.json` (`pid`, `holder`, `count`, `label`, `projects`,
`createdAt`) and touches it while it waits or holds; the daemon answers `grant-<id>.json` or `deny-<id>.json` (`why`)
and keeps `arbiter.json` fresh (the counts line, who waits, who holds) every 15 s, every 5 s while anything waits or
holds. The daemon looks with the process listing its sandbox watch already makes (cached 5 s).

**Where it shows.** `list_sandboxes` (the machine's header and its Capacity line), `system_status` (each machine's
line), the dashboard's group header (`4/3 editors`) and `unity status` all say "editors 4 of 3: 1 interactive, 3 batch",
with what waits, the RAM line and the game players. A machine with no `max_unity` (no sandbox root) is counted and never
held up. Tests: `server/unitySlots.test.ts`, the w469 tests in `server/machineSandboxes.test.ts` and
`server/beastMachine.test.ts`.

## Each sandbox's Unity MCP reaches only its editor

MCP-for-Unity (stdio) finds editors through the status files every editor writes to `~/.unity-mcp`.
Pinned (`set_active_instance`) to an editor it can no longer find, because it is restarting, reloading
or has crashed, it reconnects to whatever discovery finds next: the newest status file, the newest
port file, or port 6400. That is another sandbox's editor, or the live game's. The pin itself is per
server process (its `session_key: global` is only the in-process key), so the leak was the fallback.

So each sandbox's workers run their `UnityMCP` server with `UNITY_MCP_STATUS_DIR` set to a folder of
their own, `data/unity-mcp/<sandbox>` (`server/unityMcp.ts`, `unityMcpServerFor`; `switch_branch`'s
own bridge too). The sandbox poll (every 3 s, `syncStatusDir`) keeps in it only that sandbox's editor's
status file, while its process is alive and only if the file was written since that editor was
launched: a crashed editor's leftover file may name a port another editor has taken since. It also
writes the legacy `unity-mcp-port.json` there with the editor's own port, or 0 while it is down, so the
fallback's last step never reaches port 6400. `mcpforunity://instances` lists only the sandbox's own
editor, and a call made while it is down fails instead of landing elsewhere. Editors keep writing to
`~/.unity-mcp`, so this needs no editor restart, and the hang detection is unchanged. The guard still
refuses Unity MCP calls until the worker pins its own `<sandbox>@<hash>`.

Not covered: agents on the Macs (one clone per Mac) and Claude Code sessions outside FF Factory.
