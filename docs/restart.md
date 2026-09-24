# Restarting and updating the app

One command, from any shell, admin or not, at the desktop or over SSH:

```
scripts\restart.cmd                  # double-click works too
scripts\restart.ps1 -Update          # pull, npm ci (root and web), rebuild the web UI, then restart
scripts\restart.ps1 -NoDrain         # restart at once
scripts\restart.ps1 -DrainMinutes 3
```

`scripts\update.ps1` is `restart.ps1 -Update`. Without the user at the desktop, the orchestrator's
`request_app_update` tool takes the same path (drain, update, restart, resume).

## What happens

1. **Drain.** The script writes a JSON `data\restart.request`. The server sends every busy worker a
   `[app restart pending]` message: commit and push your work (a WIP commit is fine) and end your
   turn. It waits until no worker is mid-turn, or until `-DrainMinutes` (default 10) passes. With
   nobody busy it goes straight on. The orchestrator and standing agents are not waited for. The
   dashboard shows a "Restart pending" banner meanwhile. The supervisor keeps running during the
   drain; if the script is interrupted, the server gives up after 5 more minutes, tells the drained
   workers to carry on, and nothing is lost.
2. **Stop.** The script stops the supervisor, then asks the server to stop. The server writes
   `data\resume.json` (below), stops the agent processes, saves state and exits. Unity editors keep
   running.
3. **Update** (with `-Update`). The script leaves `data\update.request`. The next supervisor runs
   `update-steps.ps1` before starting node, and writes the outcome to `data\update.result.json`.
   It fast-forwards. If the upstream has a new, unrelated history (republished) or was rewritten
   (e.g. commit identities cleaned), it moves to it only when nothing would be lost: no modified
   tracked files and, for a rewrite, no local commit without an equivalent upstream and this tree in
   the upstream's history. The old HEAD stays on a `pre-republish-*` / `pre-rewrite-*` branch.
   Otherwise the update stops with the reason. Note that it runs the `update-steps.ps1` already on
   disk: a change to it takes effect from the update after the one that brings it.
4. **Start**, always through the Limited `ffsb-server` task (`schtasks /run /tn ffsb-server`),
   never from the calling shell, so the app cannot inherit admin rights. If the task is missing or
   does not start a supervisor within 60 s, the script starts the supervisor directly. From an
   elevated shell that app runs elevated: it refuses to start Unity and shows a banner.
5. **Resume.** The new server reads `data\resume.json` (renamed to `resume.done.json` first, so it
   is used once) and sends each listed worker:
   > The app restarted (update at …). Your process was stopped; the worktree, the Unity editor and
   > your history are intact. Check git status for half-written edits, re-pin your Unity instance,
   > and continue where you left off.

   plus any messages it had not answered yet. It then sends the orchestrator one `[app restarted]`
   paragraph: the version before and after ("Version 0.1.0 → 0.2.0."), who was resumed, who could
   not be (and why), the update result, and whether the code changed.

The script logs to `data\supervisor.log` and waits for the new server (3 min, or 20 with
`-Update`). It is safe to run twice: a second run while one is in progress exits at once, and a run
with nothing running just starts the app.

## Who is resumed

`collectResume` in `server/restart.ts` (tests in `restart.test.ts`):

- **Workers** that were mid-turn (running, starting, or waiting for a permission answer), had
  messages no finished turn had answered, or were asked by the drain to pause.
- **Idle workers stay idle.**
- **Standing agents** are left to their scheduler; an interrupted run is recorded as interrupted
  and the schedule continues.
- **The orchestrator** is not resumed as such; the summary message wakes it, and says so if it was
  mid-turn itself.

The drain's own message is left out of the "unanswered" list. A resumed worker still reports its
turns to the orchestrator if its interrupted turn came from the orchestrator.

Without a clean stop (a crash, or a kill after the 60 s grace), there is no resume file. The new
server then only tells the orchestrator which workers were cut off; it does not resume them, so a
crash loop cannot keep restarting paid turns.

## Never elevated

Everything the server starts inherits its token: agent shells, and every Unity editor. An elevated
editor stops on Unity's "running as administrator" dialog ([unity-dialogs.md](unity-dialogs.md)).
Layers that keep the app non-elevated:

- `restart.ps1` always starts through the Limited task. `start-server.ps1` run from an elevated
  shell hands over to `restart.ps1`. `supervise.ps1` started elevated runs the task and exits.
- **The server checks at startup** (`server/elevation.ts`: `whoami /groups`, high integrity or an
  enabled Administrators group). If it is elevated, supervised, and a Limited task exists, it starts
  `restart.ps1 -NoDrain` detached, waits for it to stop the supervisor, and exits. The task then
  brings up a fresh non-elevated supervisor and server. If it cannot hand off (no task, a task at
  RunLevel Highest, no supervisor, `FFSB_NO_DEELEVATE` set, or a hand-off tried within 15 minutes),
  it keeps running but refuses to start Unity. The refusal shows on the sandbox card, in a dashboard
  banner and in the logs.
- A non-elevated shell cannot stop an elevated app, because it cannot even read its command line.
  `restart.ps1` detects that and says what to do: run `restart.cmd` once as administrator.

Editors started while the app was elevated stay elevated until they are stopped and started again.
A non-elevated server recognises them by their window title, and the card says they run with
administrator rights. It cannot stop them itself; close them on the desktop.

## Files in data\

| File | Written by | Meaning |
|---|---|---|
| `restart.request` | scripts, `request_app_update` | empty: stop now. JSON: drain first (`drain`, `drainMinutes`, `reason`, `update`, `hold`) |
| `drain.done` | server | the drain finished; `restart.ps1` may stop the supervisor |
| `resume.json` / `resume.done.json` | server | sessions to resume / the last one used |
| `update.request` | `restart.ps1 -Update`, server | the next supervisor updates first |
| `update.result.json` | supervisor | `ok`, `error`, `headBefore`, `headAfter`, `at` |
| `deelevate.last` | server | when it last handed itself to the task |
| `restart.lock` | `restart.ps1` | one restart at a time |
| `orchestrator-inbox/*.txt` | local scripts (`republish-public.ps1`) | sent to the orchestrator as a system message within 5 s, then renamed `*.sent` |
| `republish.pid`, `republish/` | `republish-public.ps1` | the running republish; its bare clone of the private repo and the scanned tree |
