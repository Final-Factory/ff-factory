# w605 Part 2 notes (work in progress, paused 2026-10-07 for BEAST's daemon update)

Part 1 is PR #191 (branch w605-protocol-version). This file is a scratch design note for Part 2; it is replaced by
the real docs (worker-install.md "Updating", machines.md) in the Part 2 PR.

## Measured on BEAST (2026-10-07, a throwaway scheduled task, removed)
- The daemon's whole tree (run-daemon.ps1, node daemon, claude.exe, its shells) is inside Task Scheduler's job object;
  that job's LimitFlags are 0 (no kill-on-close, no breakaway).
- Stop-ScheduledTask ends only the task's action process (run-daemon.ps1); every other process in the job lives on.
- When node exits, its plain spawn() children die (libuv's own KILL_ON_JOB_CLOSE job); spawn({ detached: true })
  children live on. So agents die on any daemon exit today, Stop-FFDaemon or not.

## Design
- machine/agentHost.ts: one detached node process per agent process lifetime (spawn detached, stdio to
  <appDir>/agents/<id>/host.log). It runs AgentSession itself (the SDK query, canUseTool, the guard hooks); the
  in-process MCP tools are proxied to the daemon (rpc over the files below; wait for a daemon to come back).
- Files, one writer each: out.jsonl (host -> daemon: session/event/amend/image/delta/signal/rpc/state, transcript
  seq assigned in the host), in.jsonl (daemon -> host: send/interrupt/stop/mode/decide/rpc_result/editorUp/close),
  host.json (sessionId, hostProtocol, pid, spec), state.json (latest info, live), beat (heartbeat), read.offset (the
  daemon's position in out.jsonl, persisted after forwarding, so a new daemon replays exactly what it missed).
- Daemon: a HostedSession implements SessionHandle; on start it scans agents/*/host.json, adopts hosts whose pid is
  alive and beat fresh and hostProtocol supported, and reports them live in its hello. A dead host's session is
  reported not live; the portal's resumeCutOff resumes it with its sdkSessionId (claude --resume).
- Installer: Stop-FFDaemon (server/machineDeployWin.ts) and worker.ts stopRootProcesses skip agentHost.ts processes
  and their trees, as Unity is skipped. Mac: hosts start with setsid (detached), outside the launchd job's process
  group (launchd.plist AbandonProcessGroup semantics); check worker.ts's mac stop path (stopRootProcesses ~1076).
- The first reinstall onto this version still stops agents (they are plain children of the old daemon).
- Tests: a real daemon process + real host processes with a fake query (setQueryForTesting) on CI Windows + Linux
  (+ a macOS job), the daemon killed mid-turn and a new one adopting; then a real install on BEAST against the
  throwaway portal (scripts/worker/test/portal.ts) with a real claude agent mid-turn across an installer re-run.

## Next
Read worker.ts stopRootProcesses (~1076) and the mac stop, daemon.ts's send/stop/interrupt/shutdown handlers and
server/maxEvents.ts FileTail; then write agentHost.ts + HostedSession.
