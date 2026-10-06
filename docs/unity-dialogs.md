# Unity dialogs that stall an editor

An editor can stop on a modal dialog and sit in "starting" until someone clicks it. The first case
(2026-09-23, sandbox blackhole-master) was Unity's administrator warning: the app had been restarted
from an elevated PowerShell, so the server and every editor it launched had admin rights. Since w510
(2026-10-06) the portal starts no editor: every editor is a machine daemon's, and so is this watch. Two things guard
against that case and the rest:

- **Nothing that starts an editor runs elevated.** A daemon runs in its own non-elevated task (`LeastPrivilege`,
  [machines.md](machines.md)), and the portal hands itself to the Limited task (`server/elevation.ts`,
  `scripts/restart.ps1`, [restart.md](restart.md)) so the orchestrators' shells are not elevated either.
- **The watch** (`MacUnityWatch` in `machine/unity.ts`, run by each machine's daemon, BEAST's included, with the rule table
  in `server/watchdog.ts`) looks at each editor's top-level windows every 30 s. A known harmless dialog gets its safe
  button pressed. Any other dialog, or one that keeps coming back, is reported once as a
  `[unity] machine <id>: …` message to the orchestrator and a host notification, and `unity status` on that machine
  lists it with its title, text and buttons. An editor waiting on a dialog is never restarted as hung. A starting
  editor whose log has not grown for 15 minutes counts as hung and is restarted
  ([unity-lifecycle.md](unity-lifecycle.md)). Before w510 the portal ran the same table over its own editors from
  `SandboxManager.poll()` (every 10 s while starting, 60 s running; config `unity.watchdog`, retired), marked the sandbox
  `blocked` and messaged its agents; none of that exists any more.

## How the watchdog sees dialogs

`scripts/unity-windows.ps1` lists the visible top-level windows of the editor process and of any
process it started, such as the licensing client. Unity's dialogs are plain Win32 dialogs (class
`#32770`). The message sits in a read-only Edit control, which `GetWindowText` cannot read across
processes, so the script sends `WM_GETTEXT` with a timeout instead. It presses a button with a
posted `BM_CLICK`. UI Automation reports those buttons as panes, so it is only a fallback. This
was checked on this host against a live editor's "Connection Lost" dialog, and end to end against a
test message box (probe, match, press "Ignore", dialog closed, the app received "Ignore").

Window titles, texts and (on a machine) command lines can hold control characters, which Windows PowerShell 5.1's
`ConvertTo-Json` passes through raw and `JSON.parse` refuses. The script drops them (tab and line breaks aside), and
the Node side reads the output with `parsePsJson` (`server/watchdog.ts`): raw control characters in strings are
escaped, and an entry that still does not parse is skipped and logged instead of failing the whole watch.

A window counts as a dialog when it is a `#32770` with at least one button that is not just
"Cancel". Splash and progress windows have no buttons. An unknown dialog is reported only if it is
still there on the next look. A known dialog that comes back three times within 10 minutes is
reported instead of pressed again, except the ones with a standing always-rule (FMOD line endings
and Safe Mode: always Ignore; the Addressables build report prompt: always No). Those are pressed every time they come back, up to one press per 20 s
and 30 an hour (`ALWAYS_LIMIT`); only a faster loop is reported. Every press is logged as before. Unity puts `Administrator:` at the start of its main window
title when it runs elevated; nothing in the daemon reads that.

## Decisions

The strings come from `Unity.dll` of 6000.3.19f1 (the dialog title, text and buttons sit side by
side in the binary) or from the game's own editor code. The flags come from the
[command-line docs](https://docs.unity3d.com/6000.3/Documentation/Manual/EditorCommandLineArguments.html).
Only a button that changes nothing on disk is ever pressed automatically. Everything destructive or
ambiguous is "notify": it is reported to the orchestrator, which restarts the editor or asks a person
(see [Who answers](#who-answers)).

| Dialog (title / text) | Buttons | Decision | Why |
|---|---|---|---|
| "Unity is running as administrator." | "I wish to continue at my own risk" / "Restart Unity as a standard user" | **Avoid**; notify a **person** if seen | No daemon starts Unity elevated (its own `LeastPrivilege` task). "Continue" is the risky choice. "Restart as a standard user" relaunches Unity through the shell under a pid the app does not track. |
| "Repair FMOD Libraries": "The following FMOD libraries contain incorrect line endings…" (`Assets/Plugins/FMOD/src/Editor/EditorUtils.cs` `CheckMacLibraries`, runs at every editor start) | "Repair" / "Ignore" | **Auto: Ignore** | the user's rule: anything about line endings gets Ignore, never a convert or repair button. Ignore leaves the files alone. Matched on the title or any text mentioning "line endings"; with no Ignore button it is reported instead. |
| "Enter Safe Mode?": "The project you are opening contains compilation errors…" | "Enter Safe Mode" / "Ignore" | **Auto: Ignore** | Ignore opens the editor normally, errors and all, so the MCP bridge loads and an agent can fix the code. Safe Mode would keep the bridge from loading. Nothing on disk changes. |
| "Addressables Build Report": "There's a new Addressables Build Report you can check out after your content build. However, this requires that 'Debug Build Layout' is turned on… Would you like to turn it on?" (com.unity.addressables 2.9.1 `BuildScriptBase.NotifyUserAboutBuildReport`, on a content or player build, not in batch mode) | "Yes" / "No" | **Auto: No** (always-rule) | the user's rule. Yes would turn on Debug Build Layout, which makes every content build slower. There is no EditorPrefs key or project setting to suppress it: the "already asked" flag (`userHasBeenInformedAboutBuildReportSettingPreBuild`) lives in the project's `Library/AddressablesConfig.dat` (`ProjectConfigData`, a BinaryFormatter file) and either answer sets it, so after the first No it does not come back for that sandbox until its Library is rebuilt. The app does not pre-write that file: its binary format belongs to the package, and one press per Library is cheap. |
| "Font Coverage": "No coverage errors. See the Console for the full report." / "Atlases rebuilt. No coverage errors." (the game's `Assets/Editor/FontCoverage.cs`, menu Tools > Localization > Validate Font Coverage / Rebuild Font Atlases) | "OK" | **Auto: OK, only when it reports no problem** | An informational summary from a project tool: OK only closes it. The rule for such dialogs (`singleButton`, `problem`): pressed only when OK is its one button, and reported instead when its text mentions an error, a failure or something missing once "No coverage errors" is taken out, e.g. "3 coverage error(s)" or "…coverage error(s) remain". Agents should not need the dialog at all: `Editor.FontCoverage.ValidateFontCoverageOrThrow()` (through `execute_code`) validates, writes `Localization/FontCoverageReport.txt` and throws on errors, and `Editor.FontCoverage.RebuildFontAtlases()` rebuilds; both are dialog-free and are what the build scripts call (`BuildCommand2.cs`, `ReleaseBuild.cs`). |
| "Connection Lost": "The connection with the Unity Licensing Client has been lost." | "Retry" | **Auto: Retry** (always-rule); **a fresh editor** when it is back 3 times in 10 minutes | Seen live on this sandbox's editor (agent-mcp, 2026-09-23). Retry only reconnects. When it comes back for the 4th time within 10 minutes (`restartAfter`), pressing is not helping: the editor is force-restarted, since a fresh editor starts a fresh licensing client. That counts toward the automatic restart limit (docs/unity-lifecycle.md). On every machine. |
| "The open scene(s) have been modified externally": "The following open scene(s) have been changed on disk: … Do you want to reload the scene(s)?" (`EditorSceneManager.cpp`) | "Reload" / "Ignore" | **Auto: Reload when the scenes count as clean**; otherwise it is reported and a restart is the answer, **never Ignore** | Raised when git rewrites the file of a scene open in the editor: a branch switch, but also a rebase, merge, reset, pull or stash (mp-r2, 2026-10-03: a worker's `git merge origin/develop` at 21:13 Z staged `main.unity`, the git check below failed, and the old rule sent it to a person). Pressed when no `*.unity` file in the sandbox has uncommitted changes (`git status`; until w510 a `switch_branch` check of the open scenes over the MCP bridge also counted, on the host). Never when the editor's title has a `*`. Otherwise the dialog is reported once (the `[unity]` notice above), and its agents or the orchestrator restart the editor with the `unity` tool, which is the same as Reload; the `answer_dialog` action the portal's watch offered until w510 is gone, and the `unity` tool takes only status, start, stop and restart. "Ignore" is never pressed (`never`): it keeps the old scene in memory, and a later save would overwrite the file git just wrote. Edits held only in the editor cannot be kept either way (the editor cannot save while it asks), so an agent that needs them notes them, reloads and redoes them. |
| "Project Upgrade Required" / "Project Downgrade Required" / "Project Change Required" | "Continue" / quit | Notify a **person** | Continuing rewrites the project for another Unity version. The app already picks the editor from `ProjectVersion.txt`, so this means that version is missing or the file changed. |
| "Precompiled Assemblies Update Consent Request": "Unity found assemblies using deprecated Unity APIs…" | Yes / No | Notify | Yes rewrites assemblies; No may leave the project broken. Someone decides. |
| "Corrupted Library Detected" | "Rebuild Library" / "Don't rebuild Library" | Notify | A rebuild re-imports everything (hours on this project); not rebuilding may not open. |
| "Recovering Scene Backups": "Scene backups from a previous Editor session have been detected… Do you want to copy and preserve these backups in Assets/_Recovery/?" | "Yes" / "No" | **Auto: No, only when no `*.unity` file has uncommitted changes**; otherwise notify | Appears after an editor was killed or crashed. Agents do not make manual scene edits, and Yes would copy the backups into `Assets/_Recovery/` as untracked files. With a modified scene file in the tree, the backups may hold real work, so a person decides. |
| "Unity Package Manager Error" (and "Unity Package Manager: Manifest relocation") | "Retry" / "Continue" / "Diagnose" | Notify; agents never press Retry | Retry relaunches Unity as a new process the app does not track (a restart through the unity tool does the same, tracked); Continue opens with packages missing. Read the log first. |
| "License error" / "No valid Unity Editor license found…" | "Open Hub" and others | Notify a **person** | The licence has to be fixed in Unity Hub; nothing to dismiss. |
| "Unsupported Platform": "Support for the selected build platform has been deprecated…" | "Switch Platform" / "Exit Unity" | Notify | Switching changes the project's build target. |
| "Auto Graphics API" notice | "Confirm" / "Auto" | Notify | Either choice changes Player Settings. |
| Anything else | — | Notify | Reported with the full text and buttons; `unity status` lists it. |

### Avoiding dialogs up front

- **Scenes modified externally**: `switch_branch` on a machine sandbox is refused while its editor runs (stop it
  first), so Unity has no open scene to ask about. Until w510 the host's own sandboxes did better (w294):
  `switch_branch` opened one bridge session before touching git, read the open scenes, swapped them for an empty scene
  with none dirty, switched, refreshed and reopened them (`editorSwitchPlan`, `server/switchBranch.ts`;
  `discard_scene_edits` threw away unsaved edits); that code was deleted with the host's editors. A `git rebase`,
  merge or pull with the editor open still raises the dialog, and the watch's Reload rule above answers it. Refreshing
  through the bridge alone would not help, because the question comes from the import itself, whoever starts it.
  Two things checked in 6000.3.19f1 that rule out shortcuts:
  - **The title bar cannot tell whether a scene is dirty.** `EditorApplication.GetDefaultMainWindowTitle`
    builds "project - scene - target - Unity x (ver)" with no dirty mark. The only `*` comes from
    `ContainerWindow.UpdateTitle`, driven by `EditorWindow.hasUnsavedChanges` (Animation window, UI
    Builder, Search index and similar), never by a scene. So a `*` is a reason not to press, but no `*`
    proves nothing. The watchdog therefore presses Reload only on the app's own recent check.
  - **`-automaticallyReloadModifiedScenes`** is a real editor argument (Unity.dll checks it with
    `HasARGV` right before showing this dialog) that reloads without asking. It is not used: it would
    also throw away unsaved scene edits.

- **Administrator**: avoided by never running elevated (above). This is the one that stalled
  blackhole-master.
- **Safe Mode**: `-ignorecompilererrors` is documented ("Unity continues to start your application
  even if there are compilation errors"). It is not added by default: the docs do not say whether it
  also suppresses the interactive Safe Mode prompt, and pressing "Ignore" has the same effect. The knob to try it was
  `unity.extraArgs` (retired with the portal's editors, w510); a daemon builds its own command line
  (`machine/unity.ts`: `-projectPath` and `-logFile`).
- **API Updater**: `-accept-apiupdate` is documented for batch mode only, and it would rewrite code
  unasked. Not used.
- **Package Manager**: `-noUpm` is documented, but it disables the Package Manager, and with it the
  MCP bridge package. Not usable.
- **FMOD line endings**: the dialog appears when a mac bundle's `Contents/Info.plist` is checked out
  with CRLF. The game repo has no `.gitattributes` rule for those files, and the reference host has
  `core.autocrlf=true`. This worktree has them as LF (`git ls-files --eol`), so it depends on how
  a checkout was made. Without touching the game repo, the base clone could get a machine-local rule
  in `.git/info/attributes` (shared by every worktree): `Assets/Plugins/FMOD/**/Info.plist text eol=lf`,
  followed by a re-checkout of those three files in existing sandboxes. Not applied: Ignore already
  handles it, and the rule should be tested on one sandbox first.
- Unity's own "inconsistent line endings in the '%s' script" message is a console warning from the
  importer, not a dialog. Only the FMOD one blocks.

Not found in 6000.3's `Unity.dll`, so not handled specially: a dialog for another instance holding
the project lock, "Opening Project in Non-Matching Editor Installation" (a Hub dialog), and
input-system or render-pipeline restart prompts. Any of them would still be reported as an unknown
dialog.

## Macs

Every machine daemon (BEAST's too) runs the rule table for the editor of its clone and of each of its sandboxes, from
its Unity watch every 30 s (`machine/macDialogs.ts`, `MacUnityWatch` in `machine/unity.ts`). This section starts with
the Mac side, because it came first; the same watch runs on Windows (below). It lists Unity's windows and
their sheets through System Events (`osascript -l JavaScript`): an alert window (`AXDialog`,
`AXSystemDialog`) or a sheet with named buttons counts as a dialog. An alert's first text is its title,
the rest its text. The button is pressed with System Events after checking that the window still shows
the same text. The decisions and rate limits are the ones above. For the two scene rules
("scenes modified externally" Reload, "Recovering Scene Backups" No), clean means that no `*.unity` file
in the clone has uncommitted changes (a read-only `git status`); the Reload also needs the main window
title, without a `*`. A dialog that needs a person, or an unknown one still there on the next look, is
sent once as a `[unity]` notice to the orchestrator. An editor waiting on a dialog is never restarted as
hung. `unity status` on the machine lists the open dialogs, the answers of the last hour, and a missing
permission.

Windows machines (BEAST included) run the same watch: the daemon reads the editor's windows with
`scripts/unity-windows.ps1` (deployed with the daemon's code) and presses buttons with it, with the main window title
from Unity's own `UnityContainerWndClass` window. Each automatic answer is logged in the daemon log
(`unity <project>: dismissed "<title>" with "<button>"`; before w510 the portal's own watch logged
`unity <sandbox>: dismissed ...` lines of the same shape).

Machines also close a few editor windows that are not dialogs (`CLOSABLE_WINDOWS` in `server/watchdog.ts`),
matched on their whole title, as their title bar's close button does (`WM_CLOSE` on Windows, the window's
`AXCloseButton` on a Mac), after checking the title again:

| Window | Where it comes from | Decision |
|---|---|---|
| "FMOD Setup Wizard" | `Assets/Plugins/FMOD/src/Editor/SetupWizard.cs` `SetupWizardWindow.Startup()`, at every editor start while the FMOD settings' `HideSetupWizard` is off (a utility window) | **Auto: close.** The window has no `OnDisable`/`OnDestroy`, so closing it writes nothing; only its own buttons change settings. It comes back at the next start and is closed again. Logged as `closed "FMOD Setup Wizard"`; the always-rule limits apply (back within 20 s, or 30 times an hour, is reported instead). |

macOS privacy settings have to allow this once per Mac. Code cannot grant them, and the daemon does not
try:

- **Accessibility**, for the daemon's node binary (the process launchd starts, which macOS holds
  responsible for its `osascript`). Missing: osascript fails with "not allowed assistive access" (-25211).
  Fix: System Settings > Privacy & Security > Accessibility > +, Cmd-Shift-G, the node path (the notice
  names it; the real path, e.g. `/opt/homebrew/Cellar/node/<v>/bin/node`), switch on. After a node
  upgrade, add it again.
- **Automation**, "node" may control "System Events". Missing: "Not authorized to send Apple events to
  System Events" (-1743). macOS asks once on the Mac's screen ("node wants access to control System
  Events", Allow) when someone is logged in. If it was declined, switch it on under Privacy & Security
  > Automation > node.

When either is missing, the watch sends one notice with the exact step and shows it in the status; the
hang and crash watch keeps working without it. It notices by itself when the permission arrives.

A locked screen, another user at the console (fast user switching) or a sleeping display make System
Events fail in ways that look like a missing permission. Before reporting one, the watch asks macOS
(`CGSessionCopyCurrentDictionary`: `CGSSessionScreenIsLocked`, `kCGSSessionOnConsoleKey`;
`CGDisplayIsAsleep`): then it pauses ("dialog watch paused: the screen is locked") and resumes by itself.
A permission is reported only when `AXIsProcessTrusted()` also says it is missing, and only once it
lasts: 3 failed looks in a row across at least 15 minutes with the screen awake and unlocked. No notice
(paused, permission, back) goes out more than once a day. A look that sees no windows at all (System
Events does not know the process) proves nothing either way. The editor is the Unity process with the
clone open that is not `-batchMode`: its AssetImportWorkers (same binary, same `-projectPath`) and
command-line builds are not it (on m5, picking a worker was what made the watch "see again" now and
then). Each failed look is logged in the daemon log with the session state and `AXIsProcessTrusted`.
An Accessibility entry for node that is listed but switched off is still denied (TCC `auth_value` 0).

## Who answers

Whatever the watch does not press itself goes to the orchestrator as one `[unity] machine <id>: …` message, with a
host notification (`machines.unityEvent`, `server/index.ts`). The orchestrator then decides,
with the `unity` tool (status, start, stop, restart; `force: true` for a frozen editor), and a person is needed only for
the dialogs marked `person` (administrator, licence, project version) and for an editor that used up its automatic
restarts. After an automatic restart the editor's own agents (those running, or active in the last 30 minutes) are told
too ([unity-lifecycle.md](unity-lifecycle.md)). Until w510 this host's sandboxes had a richer path: each active worker
got a `[unity blocked]` message with an `answer_dialog` action that pressed a button after `checkAgentAnswer`
(`agentAnswers`, `server/unityBlocked.ts`, `SandboxManager.answerDialog`), and a "Unity editor stuck" notification went
to the user. All of that was the portal's own editors', and was deleted with them; machines never had `answer_dialog`.

## Hooks

A daemon sends the watch's text to the portal as `unity_event` (`MacUnityWatch`'s report in `machine/daemon.ts`;
`restarted` is set when it restarted the editor). Every dismissal is kept in the watch (`dismissed`, the last 40,
listed by `unity status` for the last hour) and logged to the daemon's log.
