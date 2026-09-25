# Unity dialogs that stall an editor

An editor the app starts can stop on a modal dialog and sit in "starting" until someone clicks it.
The first case (2026-09-23, sandbox blackhole-master) was Unity's administrator warning: the app
had been restarted from an elevated PowerShell, so the server and every editor it launched had
admin rights. Two things now guard against this:

- **The app never runs elevated** (`server/elevation.ts`, `scripts/restart.ps1`). See
  [restart.md](restart.md).
- **The watchdog** (`server/watchdog.ts`, driven from `SandboxManager.poll()`) looks at each
  editor's top-level windows: every 10 s while it is starting, every 60 s once it runs
  (`unity.watchdog` in config.json). A known harmless dialog gets its safe button pressed. Any other
  dialog puts the sandbox in the `blocked` state with the dialog's title, text and buttons. So does a
  starting editor whose log has not grown for `stallMinutes` (default 15). `blocked` shows on the
  sandbox card, in the `unity` status tool (first line `blocked: <title>: <text>`) and in a
  `[unity blocked]` message to the orchestrator. It clears when the dialog closes or the log moves
  again.

## How the watchdog sees dialogs

`scripts/unity-windows.ps1` lists the visible top-level windows of the editor process and of any
process it started, such as the licensing client. Unity's dialogs are plain Win32 dialogs (class
`#32770`). The message sits in a read-only Edit control, which `GetWindowText` cannot read across
processes, so the script sends `WM_GETTEXT` with a timeout instead. It presses a button with a
posted `BM_CLICK`. UI Automation reports those buttons as panes, so it is only a fallback. This
was checked on this host against a live editor's "Connection Lost" dialog, and end to end against a
test message box (probe, match, press "Ignore", dialog closed, the app received "Ignore").

A window counts as a dialog when it is a `#32770` with at least one button that is not just
"Cancel". Splash and progress windows have no buttons. An unknown dialog is reported only if it is
still there on the next look. A known dialog that comes back three times within 10 minutes is
reported instead of pressed again, except the ones with a standing always-rule (FMOD line endings
and Safe Mode: always Ignore; the Addressables build report prompt: always No). Those are pressed every time they come back, up to one press per 20 s
and 30 an hour (`ALWAYS_LIMIT`); only a faster loop is reported. Every press is logged as before. Unity puts `Administrator:` at the start of its main window
title when it runs elevated; the watchdog notes that on the card, and a non-elevated server uses
the title to recognise an elevated editor it can no longer read the command line of.

## Decisions

The strings come from `Unity.dll` of 6000.3.19f1 (the dialog title, text and buttons sit side by
side in the binary) or from the game's own editor code. The flags come from the
[command-line docs](https://docs.unity3d.com/6000.3/Documentation/Manual/EditorCommandLineArguments.html).
Only a button that changes nothing on disk is ever pressed. Everything destructive or ambiguous
is notify-only.

| Dialog (title / text) | Buttons | Decision | Why |
|---|---|---|---|
| "Unity is running as administrator." | "I wish to continue at my own risk" / "Restart Unity as a standard user" | **Avoid**; notify if seen | The app never starts Unity elevated: an elevated server hands itself to the Limited task or refuses to start editors. "Continue" is the risky choice. "Restart as a standard user" relaunches Unity through the shell under a pid the app does not track. |
| "Repair FMOD Libraries": "The following FMOD libraries contain incorrect line endings…" (`Assets/Plugins/FMOD/src/Editor/EditorUtils.cs` `CheckMacLibraries`, runs at every editor start) | "Repair" / "Ignore" | **Auto: Ignore** | the user's rule: anything about line endings gets Ignore, never a convert or repair button. Ignore leaves the files alone. Matched on the title or any text mentioning "line endings"; with no Ignore button it is reported instead. |
| "Enter Safe Mode?": "The project you are opening contains compilation errors…" | "Enter Safe Mode" / "Ignore" | **Auto: Ignore** | Ignore opens the editor normally, errors and all, so the MCP bridge loads and an agent can fix the code. Safe Mode would keep the bridge from loading. Nothing on disk changes. |
| "Addressables Build Report": "There's a new Addressables Build Report you can check out after your content build. However, this requires that 'Debug Build Layout' is turned on… Would you like to turn it on?" (com.unity.addressables 2.9.1 `BuildScriptBase.NotifyUserAboutBuildReport`, on a content or player build, not in batch mode) | "Yes" / "No" | **Auto: No** (always-rule) | the user's rule. Yes would turn on Debug Build Layout, which makes every content build slower. There is no EditorPrefs key or project setting to suppress it: the "already asked" flag (`userHasBeenInformedAboutBuildReportSettingPreBuild`) lives in the project's `Library/AddressablesConfig.dat` (`ProjectConfigData`, a BinaryFormatter file) and either answer sets it, so after the first No it does not come back for that sandbox until its Library is rebuilt. The app does not pre-write that file: its binary format belongs to the package, and one press per Library is cheap. |
| "Font Coverage": "No coverage errors. See the Console for the full report." / "Atlases rebuilt. No coverage errors." (the game's `Assets/Editor/FontCoverage.cs`, menu Tools > Localization > Validate Font Coverage / Rebuild Font Atlases) | "OK" | **Auto: OK, only when it reports no problem** | An informational summary from a project tool: OK only closes it. The rule for such dialogs (`singleButton`, `problem`): pressed only when OK is its one button, and reported instead when its text mentions an error, a failure or something missing once "No coverage errors" is taken out, e.g. "3 coverage error(s)" or "…coverage error(s) remain". Agents should not need the dialog at all: `Editor.FontCoverage.ValidateFontCoverageOrThrow()` (through `execute_code`) validates, writes `Localization/FontCoverageReport.txt` and throws on errors, and `Editor.FontCoverage.RebuildFontAtlases()` rebuilds; both are dialog-free and are what the build scripts call (`BuildCommand2.cs`, `ReleaseBuild.cs`). |
| "Connection Lost": "The connection with the Unity Licensing Client has been lost." | "Retry" | **Auto: Retry** (always-rule); **a fresh editor** when it is back 3 times in 10 minutes | Seen live on this sandbox's editor (agent-mcp, 2026-09-23). Retry only reconnects. When it comes back for the 4th time within 10 minutes (`restartAfter`), pressing is not helping: the editor is force-restarted, since a fresh editor starts a fresh licensing client. That counts toward the automatic restart limit (docs/unity-lifecycle.md). On the host and on the Macs. |
| "The open scene(s) have been modified externally": "The following open scene(s) have been changed on disk: … Do you want to reload the scene(s)?" (`EditorSceneManager.cpp`) | "Reload" / "Ignore" | **Auto: Reload when the scenes count as clean**; otherwise notify | Raised when a branch switch rewrites the file of a scene open in the editor. Pressed when `switch_branch` checked over the MCP bridge within the last minutes that no open scene was dirty, or else when no `*.unity` file in the sandbox has uncommitted changes (`git status`). Never when the editor's title has a `*`. The git check cannot see edits held only in the editor, but after a branch switch Reload is the right answer anyway: Ignore keeps the old branch's scene in memory, and a later save would overwrite the new branch's file. Workers are told to switch with `mcp__sandbox__switch_branch`, and the guard refuses a raw `git switch`/`git checkout <branch>` while the editor runs. |
| "Project Upgrade Required" / "Project Downgrade Required" / "Project Change Required" | "Continue" / quit | Notify | Continuing rewrites the project for another Unity version. The app already picks the editor from `ProjectVersion.txt`, so this means that version is missing or the file changed. |
| "Precompiled Assemblies Update Consent Request": "Unity found assemblies using deprecated Unity APIs…" | Yes / No | Notify | Yes rewrites assemblies; No may leave the project broken. Someone decides. |
| "Corrupted Library Detected" | "Rebuild Library" / "Don't rebuild Library" | Notify | A rebuild re-imports everything (hours on this project); not rebuilding may not open. |
| "Recovering Scene Backups": "Scene backups from a previous Editor session have been detected… Do you want to copy and preserve these backups in Assets/_Recovery/?" | "Yes" / "No" | **Auto: No, only when no `*.unity` file has uncommitted changes**; otherwise notify | Appears after an editor was killed or crashed. Agents do not make manual scene edits, and Yes would copy the backups into `Assets/_Recovery/` as untracked files. With a modified scene file in the tree, the backups may hold real work, so a person decides. |
| "Unity Package Manager Error" (and "Unity Package Manager: Manifest relocation") | "Retry" / "Continue" / "Diagnose" | Notify | Retry relaunches Unity as a new process; Continue opens with packages missing. Read the log first. |
| "License error" / "No valid Unity Editor license found…" | "Open Hub" and others | Notify | The licence has to be fixed in Unity Hub; nothing to dismiss. |
| "Unsupported Platform": "Support for the selected build platform has been deprecated…" | "Switch Platform" / "Exit Unity" | Notify | Switching changes the project's build target. |
| "Auto Graphics API" notice | "Confirm" / "Auto" | Notify | Either choice changes Player Settings. |
| Anything else | — | Notify | `blocked` with the full text and buttons. |

### Avoiding dialogs up front

- **Scenes modified externally**: `switch_branch` (`Agents.switchBranch`, `server/unityMcp.ts`) opens
  one bridge session before touching git. It reads the open scenes (`execute_code`). With none dirty
  and the editor not in play mode, it swaps them for an empty scene, switches, runs `refresh_unity`,
  then reopens them (a scene missing on the new branch is named in the result). No open scene file
  changes, so Unity has nothing to ask. With dirty scenes it leaves them alone, says so in the result,
  and does not wait on the refresh: Unity will ask, and a person answers. Refreshing through the
  bridge alone would not help, because the question comes from the import itself, whoever starts it.
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
  also suppresses the interactive Safe Mode prompt, and pressing "Ignore" has the same effect. Add it
  to `unity.extraArgs` to try it.
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

The machine daemon runs the same rule table for the editor of its clone, from its Unity watch every
30 s (`machine/macDialogs.ts`, `MacUnityWatch` in `machine/unity.ts`). It lists Unity's windows and
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
A permission is reported only when `AXIsProcessTrusted()` also says it is missing. No notice (paused,
permission, back) goes out more than once an hour.

## Hooks

`SandboxManager.events` emits `blocked` (sandbox, details) and `dismissed` (sandbox, what was
pressed). Two things listen to `blocked`: the orchestrator message (`Agents.onUnityBlocked`) and a
"Unity editor stuck" notification to the user (`Notifier.unityBlocked`, the `unity` kind in the
notification settings, on by default). Every dismissal is kept on the sandbox
(`unity.dismissed`, the last 40; the card shows the last 3) and logged to `data/server.out.log`.
