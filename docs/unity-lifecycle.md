# Unity editor lifecycle: start, stop, restart, hang and crash recovery

Unity editors crash and freeze often. The harness manages them fully, without asking anyone: agents
restart their own editor with a tool, and a watch restarts a hung or crashed editor by itself.
The dialog watchdog (modal dialogs, recovery prompts) is separate: [unity-dialogs.md](unity-dialogs.md).

## Tools

| Who | Tool | Actions |
|---|---|---|
| sandbox worker (host) | `mcp__sandbox__unity` | `status`, `start`, `stop`, `restart`, `log`; `force: true` kills a frozen editor at once |
| machine worker (Mac) | `mcp__machine__unity` | `status`, `start`, `stop`, `restart` (`force` as above) |
| orchestrator | `unity` with `sandbox` or `machine` | the same; `log` is sandbox-only |

A normal stop asks the editor to quit, then kills it after 15 s (host) or 30 s (Mac). A forced one
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

A long import, compile or test run keeps the log growing, so it is never killed. A modal dialog is
never a hang: it is the dialog watchdog's business (seen in the last 3 minutes).
The host checks each running editor every `unity.hang.checkSeconds` (30); a process listing, which
costs a few seconds, runs every 5 minutes, or at once when something already looks wrong.

## Automatic restart

On a hang or crash, `SandboxManager.autoRestart` (host) or `MacUnityWatch` (Mac daemon, every 30 s):

1. force-kills the editor and what it started, and its crash reporters;
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

The Macs get the watch and the `unity` tool with the daemon: redeploy it (`add_machine`) after an
update. An older daemon ignores the `unity` message, and the tool times out with that advice.

Tests: `server/unityHang.test.ts` (verdicts, budget, a fake bridge), `server/macUnity.test.ts`
(the Mac stop/start/restart and the watch).
