- **A Live view's idle editor closes, and reopens when the work resumes** (w1746, lothsahn: "If a live view is idle for
  more than 15 minutes can we close it down to free the box?"). After `live.idleCloseMinutes` (default 15) with no turn,
  tool, background job or check-in in its sandbox and nobody watching, the daemon leaves play mode, saves the open scenes
  and assets through the editor and quits it (skipped, with the reason logged, for an untitled dirty scene, a state it
  cannot read, compiling, or play mode with a person at the computer; never killed). The view, sandbox, branch and
  conversation stay. The next message to a worker there starts the editor with a note to stage the view again; a person
  opening the view wakes the worker. list_sandboxes and system_status show it. Docs: live-view.md ("Idle editors close"),
  machines.md. Tests: `liveIdle.test.ts`, `liveIdleMachine.test.ts`, `liveIdleDaemon.test.ts`.
