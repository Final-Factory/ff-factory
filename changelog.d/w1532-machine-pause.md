- **Pause a Windows PC from its tray** (w1532, lothsahn: "a small taskbar app that you can right click to pause and unpause all
  work on that machine"). The daemon builds and starts a tray app with the portal's F icon in the logged-on user's session
  (with the in-box C# compiler; a daemon update updates it). Its menu pauses and unpauses all FF Factory work there, sets a work
  schedule (work unpauses when a window starts and pauses when it ends) and turns the pause on a person's input on or off: a
  key or click that no program injected pauses the machine until 90 minutes pass without one, and a tray unpause ignores input
  for 30 seconds. Agents' synthetic input (SendInput, keybd_event, mouse_event, PostMessage) and a held key's auto-repeat never
  count. A paused machine is held (placement.hold: no new work, no resumes), shows amber "Paused" on the machines view, and
  hands its work back: a worker mid-turn is told to finish its step, commit and push, and hand back; its request is Queued with
  the branch and a note, and the dispatcher re-places it on another computer; forced after 15 minutes. Standing agents start no
  run there; the ops worker's updates go on. Settings live on the machine (pause.json). Docs: machines.md ("Pausing a
  machine"). Tests: `pauseRules.test.ts`, `machinePause.test.ts`, the real tray app in `machineDeployWin.test.ts`.
