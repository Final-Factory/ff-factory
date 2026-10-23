# Worker install: one root folder, one command to install, remove or migrate (w513)

**TL;DR:** A worker machine's daemon and everything its agents use live under one root folder, in any folder you pick.
`scripts/worker/install.ps1` (Windows) or `install.sh` (macOS and Linux) installs it, `uninstall` removes it and proves nothing is
left, and `migrate` moves a machine from today's scattered layout into a root (copy-first and verified, with rollback).
Built players run only from fixed player folders: each sandbox slotK owns `<root>/players/slotK-0/player/` (peer 0,
the host) and `slotK-1/player/` (peer 1, the client), and Windows Firewall gets one inbound rule per folder (w576).
The nightly run plays from its sandbox's pair since w1099; the nightly lab's own `slotnightly-0`/`-1` are gone.
`--max-sandboxes N` makes the sandboxes' count and these N pairs together. The design and the inventory it rests on: [worker-root.md](worker-root.md). lothsahn's
decisions of 2026-10-06 override it where they differ (listed at the end).

## The layout

```text
<root>/                 any folder (lothsahn, decision 1): D:\work\ffw, F:\ffw, ~/ffw ... On Windows with a Dev Drive the root
                        is <letter>:\ffw on the drive, and the folder given keeps only the drive (see "The whole root on
                        the Dev Drive")
  root.json             the install's id, layout version, machine, service name, and every thing outside the root it made
  daemon/               app/ (the daemon's code), src/ (the ff-factory checkout it was installed from), daemon.json (no
                        token), run-daemon.ps1, logs/, agents/ (standing agents), unity-mcp/, state files
  secrets/              machine-token: the machine's credential, owner-only (Windows ACL: the user and SYSTEM; macOS 0700)
  repo/                 the install's own bare clone of the game repo; every sandbox is a worktree of it
  sandboxes/<name>/     the sandboxes
  seed/Library/         the Library seed new sandboxes are warmed from
  players/slotK-0, -1/  each sandbox slotK's two player folders, K = 1..N
                        (scripts/nightly/player_slots.py, layout sandbox-pairs, w576): FF_PLAYER_SLOT_ROOT for agents
  nightly-history/      the nightly run's history (w1099): state, logs, runs, reports, lab fixtures and the lab lock; no
                        clone, Library or builds (the night is a job in a sandbox and builds there). The old nightly/
                        lab root is gone.
  scratch/              long-lived scratch; scratch/legacy/ holds what a migration archived
  tmp/                  agents' TMP, TEMP and TMPDIR (one ffa-<session> folder each)
  voice/                only with --voice-whisper (w615): the GPU Whisper for the portal's mic, uv's Python, its venv,
                        the model, setup.log (docs/voice.md "Whisper on a worker's GPU"); the daemon installs and updates it
  migration.json        only after a migration: its journal, read by rollback and cleanup
```

The daemon reads `root` from its `daemon.json` and derives the rest (`machine/daemon.ts` `withRootDefaults`, `rootEnv`).
Its agents get `FF_WORKER_ROOT` and `FF_PLAYER_SLOT_ROOT` (`FF_NIGHTLY_ROOT` went with the nightly lab root, w1099). The credential is read from
`secrets/machine-token` at start (`readToken`); a portal redeploy over ssh that writes a fresh token into `daemon.json`
still works, since that one wins.

**In the home folder, on purpose** (lothsahn, decision 3: tool dependencies may use it; nothing overrides HOME):
Claude Code's `~/.claude` (settings, plugins, and the agents' conversations under `~/.claude/projects/<folder name>`),
`~/.claude.json`, the Unity slots mailbox `~/.ff-factory/unity-slots` (w469: the one place the daemon, its agents and a
scheduled nightly harness all find with no config; the uninstall removes it), git's `~/.gitconfig` and its credential helper, gh's login, `~/.ssh`, `~/.unity-mcp` (written by the
MCP-for-Unity editor plugin), Unity's caches, logs and licence (`%LOCALAPPDATA%\Unity`, `%USERPROFILE%\AppData\LocalLow\Unity`,
`~/Library/Logs/Unity`), and the game's save and data folder (`...\LocalLow\Never Games\finalfactory`,
`~/Library/Application Support/Never Games/finalfactory`; decision 5). The uninstall leaves these.

**Outside the root, made by the install and removed by the uninstall** (listed in `root.json` `outside`):

| What | Windows | macOS |
|---|---|---|
| The service | scheduled task `FFFactoryDaemon` (at logon, the user's interactive session, not elevated) | LaunchAgent `com.fffactory.daemon` (`~/Library/LaunchAgents`); on Linux the systemd user unit `~/.config/systemd/user/com.fffactory.daemon.service` |
| Firewall rules | group "Final Factory player slots" (per slot exe path: in and out, TCP and UDP, every profile), group "Final Factory Unity editors" (each Unity editor the Hub has) and group "Final Factory agent node" (one inbound rule for `<root>\tools\node\node.exe`, the agents' node at its one fixed path, w1742); the step also deletes rules earlier prompts left for programs under `<root>\tmp` | none |
| The slot config for scripts outside the daemon | `%ProgramData%\FinalFactory\player-slots.json` | `~/.config/finalfactory/player-slots.json` |
| The Unity slots mailbox (`~/.ff-factory/unity-slots`, its standard place: no pointer is written, so the daemon, its agents and the nightly harness all use the same one, w469) | `%USERPROFILE%\.ff-factory\unity-slots` | `~/.ff-factory/unity-slots` |
| The Dev Drive (w900, w1070) | the SYSTEM tasks `ffsb-helper-mount` (also at every boot), `-trim` and `-compact`, and their script in `%ProgramData%\ffsb-helpers`; the folder given at install, which keeps the drive's file and what starts before it (`devdrive.vhdx`, `devdrive.json`, `start-daemon.ps1`, `moved.json`) | none |
| The portal's record | removed through `POST /machine/unenroll` | the same |
| The portal's ssh key (w568) | its line in `C:\ProgramData\ssh\administrators_authorized_keys` (a member of Administrators) or `%USERPROFILE%\.ssh\authorized_keys`; removed unless it was there before | its line in `~/.ssh/authorized_keys`; the same |

## Install

From a normal PowerShell (not "Run as administrator"; the one step that needs admin rights asks for it with one UAC
prompt):

```powershell
irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1 | iex
```

On a Mac, as yourself (not sudo):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)"
```

On a Linux PC, the same command, as yourself; see [Linux](#linux) for what it needs first.

It asks, all at the start: the root folder, the portal URL, the limits (sandboxes at once, agents per sandbox, Unity
editors at once; defaults 3, 2, 2), and the machine's credential (hidden). Then it checks, and **changes nothing if any
check fails**, listing every problem with its fix:

- not elevated (Windows); node 22.6+; git 2.48+ (decision 12: it offers `winget install --id Git.Git -e` and installs only on an explicit "y"; on a Mac it names `brew upgrade git`); git-lfs; Claude Code;
- the root: an absolute path whose parent exists, empty or new, or this machine's earlier install (a re-run);
- at least 20 GB free there (the clone is about 11 GB; each sandbox 15 to 125 GB on BEAST, measured in w511);
- the portal answers and accepts the credential for this machine id (`GET /machine/whoami`);
- no daemon already installed under the same service name from elsewhere (that is a migration);
- someone is logged on (Windows: the daemon runs in the interactive session for the Claude login, the GPU and Unity).

Then: the root and `root.json`; the credential into `secrets/`; a bare clone of the game repo (its own refspec, LFS on,
relative worktree paths, `core.symlinks false` on Windows; `--seed-from <clone>` seeds it from a local clone's origin branches instead of downloading, for a run with no GitHub credential such as an ssh session, LothDesktop 2026-10-07); the daemon's code from the installer's checkout, `npm ci`; `daemon.json`; the task or
LaunchAgent, started; the firewall rules for `players\slot1-0..slotN-1\player\finalfactory.exe` and the Unity editors, plus the
slot config (one UAC prompt); and it waits until the portal sees the machine online with its root. Re-running it
updates the code and keeps everything else (that is also how a root install is **updated**, see "Updating" below: the portal never
redeploys one over ssh, it says "re-run its installer" when the daemon is outdated).

**Symlinks on Windows** (w596): the root's clone gets `core.symlinks false`. The daemon runs non-elevated, where
Windows refuses to make a symlink without Developer Mode, and the game repo has one (`AGENTS.md`). Git for Windows'
installer can set `core.symlinks true` system-wide, and a clone made elevated (`--owner` over ssh) does not get the
local `false` a non-elevated one does, so every sandbox checkout failed on BEAST ("unable to create symlink AGENTS.md:
Permission denied") and the pool marked them `error`. Symlinks now check out as plain files, as in a person's clone.

**The supervisor is part of every install** (w576, lothsahn: "every worker should have a restart daemon--it should be
the standard part of the install"). It is what starts the daemon again after a crash or an update. On Windows the task
runs the root's `daemon\run-daemon.ps1`, which starts the daemon whenever it exits (backing off up to 5 minutes in a
crash loop), and Task Scheduler restarts that script if it fails. On a Mac launchd does it, by the LaunchAgent's
`KeepAlive`. The installer checks it after starting the daemon (`requireSupervisor`): the task or plist runs this root,
restarts on failure, and, when someone is logged on, is running. It fails until all of that holds. A task registered for
another folder that a non-administrator run could not replace counts as missing. Re-running the installer repairs it,
the uninstall removes it, and `check` lists it.

**The short way for a new machine: a join code** (w1592): an owner asks for one, and one line at the PC does the rest,
record and credential included ([Adding a machine with a join code](#adding-a-machine-with-a-join-code-w1592)).

**A new machine needs its record first** (w676). The installer's check `GET /machine/whoami` answers 401 for a
credential whose machine has no record ("no machine record has it"), and the daemon's link is refused the same way. A
person adds it through the dispatcher: `add_machine <id> worker_install` (with `ssh_host user@host` when the portal
will reach it over ssh) makes the record alone, with no ssh deploy and no credential, and it waits ("Setting up",
"waiting for its worker installer") until the installer's daemon says hello. It is never redeployed over ssh while it
waits. The orchestration worker can then do the rest from the portal's VM ([ops-worker.md](ops-worker.md), "A new
machine").

**The credential** is the machine's `/machine` token, `ffm_<machine id>_<secret>`: the only token on the box
([vault.md](vault.md), "Enrollment is the machine token", w512). In the portal's VM, `sudo fffctl machine-credential
issue <id> --out /tmp/<id>.cred` writes one to a 0600 file and never prints it. Move that file to the machine and give
it to the installer with `-CredentialFile` / `--credential-file` (deleted by hand afterwards), or paste it at the hidden
prompt. Everything else a worker needs (the Claude token, the GitHub token) comes from the vault with each run, so the
installer asks for no other secret. A migration needs none: it keeps the token the old daemon already has.

### Adding a machine with a join code (w1592)

**TL;DR:** an owner clicks **Add a machine** in the dashboard (or asks their orchestrator) and gets a join code and a
Windows installer that carries it; at the new PC, connected to Tailscale, a person double-clicks the installer (or runs one
line and types the code). The PC checks its tools and installs the missing ones, enrols itself with the portal, runs
this installer with the right answers and shows what the portal sees. No credential passes through chat or the screen, and
no ssh, firewall rule or tailnet policy change is needed: the portal updates, restarts and unloads the PC over its daemon's
own link ([Updates over the daemon's link](#updates-over-the-daemons-link-w1596), w1596).

lothsahn asked for it on 2026-10-20 (w1592): "Can you make an installer I can run so this is easier in the future? I can
connect to tailscale and then it should contact the portal to set itself up with an installer." The manual route below
and in [ops-worker.md](ops-worker.md#a-new-machine) still works; this one replaces its steps 1, 3 and 4 and the ops
worker's whole job. Then, the same day: "Can it be an installer I download from the website instead of opening a ssh
tunnel?" (relayed by his orchestrator), so the dashboard hands out a download too. Then (w1596): "Yes, move updates and
restarts onto the daemon link; drop the SSH need", so the bootstrap no longer sets up ssh at all.

1. **An owner makes the code**, one of two ways:
   - **In the dashboard**: Computers > **Add a machine** (owners only). Id, the PC's tailnet device name (filled in when
     the dashboard is opened on that PC itself: `GET /api/machines/join/device` runs `tailscale whois` on the browser's
     address), and limits if any (blank: the PC's own). **Make the installer** (`POST /api/machines/join`) makes the
     record and shows the code once, with **Download the Windows installer**: `ff-factory-join.cmd` with the code
     written in, made in the browser from the answer, so the code never sits in a URL or a server log. Opened on the new
     PC, that is the whole job there: download, double-click. Opened elsewhere, take the file (or the code) to the PC.
   - **From an orchestrator** or the dispatcher's chat, in the owner's own words: "add desktop-coosego with a join code".
     The dispatcher runs `add_machine` with `join_code` (and `tailnet_name` when the PC's tailnet name differs from the id;
     limits if the owner gives any) and answers the code, valid for an hour, and where to run it.

   Both go through `MachineManager.createJoin` (server/machines.ts): the record ("Setting up", waiting for its join
   bootstrap) and the code.
2. **At the PC**, connected to Tailscale: double-click the downloaded installer (Windows warns about a downloaded file
   first: [The download and Windows' warnings](#the-download-and-windows-warnings-w1592)). Without one, open
   `https://<the portal>.<tailnet>.ts.net/join` in its browser (a tailnet-only page with the installer that asks for the
   code, `GET /join/windows.cmd`, and the commands), or paste this into a PowerShell window (as administrator or not, w1603):

   ```powershell
   irm https://<the portal>.<tailnet>.ts.net/join/windows.ps1 | iex
   ```

   A Mac or a Linux PC, in a terminal: `bash -c "$(curl -fsSL https://<the portal>.<tailnet>.ts.net/join/unix.sh)"`.
   It asks for the code (the dashboard's download has it already), shows the machine id and the limits it will use, and
   asks once before it changes anything; after that yes it installs the tools without another question (Windows itself
   asks for administrator rights for the Dev Drive).
   Options: `-Root D:\ffw`, `-MaxSandboxes N`, `-MaxAgentsPerSandbox N`, `-MaxUnity N`, `-DryRun` (checks everything, changes
   nothing, leaves the code unused), `-Yes` (asks nothing but the code). To pass them:
   `& ([scriptblock]::Create((irm https://<the portal>/join/windows.ps1))) -DryRun`.

Nothing else: no tailnet policy block, tag or grant, no OpenSSH Server, no firewall rule for it (w1596). The PC's daemon
dials the portal, as every daemon does, and the portal updates it over that link.

What the Windows bootstrap (`scripts/worker/join.ps1`) does, in order:

1. Finds the portal: the portal serves the script with its own tailnet URL written in (`GET /join/windows.ps1`), and the
   script checks `/api/health`. It reads this PC's tailnet name and tags from `tailscale status --json`.
2. Checks the code with the portal (`POST /machine/join` with `check`: nothing changes, the code stays unused) and shows
   the machine id and the limits.
3. **The tools**: node 22.6+, git 2.48+, git-lfs and Claude Code. After the one yes it installs the missing ones with winget
   (`OpenJS.NodeJS.LTS`, `Git.Git`, `GitHub.GitLFS`) and Claude Code with its own installer (`irm https://claude.ai/install.ps1 | iex`,
   which updates itself, as [Claude Code's setup page](https://code.claude.com/docs/en/setup) recommends). No winget: it
   says to install App Installer from the Microsoft Store, and lists the commands. **Unity Hub and its editors are
   reported, never installed**: an editor is several GB, its licence needs the person's own Unity sign-in, and the version
   is the game repo's (`ProjectSettings/ProjectVersion.txt`), so the person installs it in Unity Hub.
4. **Enrols**: `POST /machine/join` with the code. The portal makes the record (or updates the waiting one), issues the
   machine's credential and answers it once. The script writes it straight into `machine-credential` in a new folder
   under `%TEMP%` whose ACL is this account only, and shows its last four characters.
5. **Installs**: this installer (`install.ps1` from ff-factory's main) with `-Root -PortalUrl -MaxSandboxes
   -MaxAgentsPerSandbox -MaxUnity -CredentialFile -NoSsh`: the Dev Drive, the clone, the daemon's task, the firewall rules
   for the player slots; no portal ssh key or host-key pin (w1596). Then it deletes the credential file, and the folder it
   made for it, whether the installer succeeded or not. It deletes nothing else.
6. **Shows what the portal sees**: `GET /machine/whoami` (online, the daemon's commit, the root).

Until w1596 it also turned on OpenSSH Server with a tailnet-only firewall rule, put the portal's ssh key in and pinned the
PC's host keys, and offered the tailnet tag `tag:fff-worker`, all so the portal could update the PC over ssh.

The Mac and Linux bootstrap (`scripts/worker/join.sh`) does the same with Homebrew for the tools (Linux: it names what to
install), runs `install.sh --no-ssh`, and writes the credential into a 0600 file in a 0700 `mktemp -d` folder. Remote Login
(sshd) is no longer checked (w1596).

**Run again on an installed PC** (its daemon's task points at a root with `root.json`, or `-Root` names one), it needs no
code: it updates the install (`install.ps1 -Update -Root <root>`, with any limit given) and checks the tools again. A PC
that joined with ssh keeps it: the update carries the portal's ssh as the install had it (`planUpdate`, from `root.json`),
and the bootstrap neither turns OpenSSH Server off nor on. A PC whose first run stopped before the installer finished asks for a new code; the owner's new code
replaces the old one, and the portal updates the same record, never a second one.

**The decisions, and what each rests on:**

| Decision | Chosen | Why |
|---|---|---|
| How the PC proves it may join | A one-use code, 100 bits (20 characters of Crockford base32, `XXXXX-XXXXX-XXXXX-XXXXX`), valid 60 minutes, bound to one machine id, the limits the owner gave and **one tailnet device**: the portal runs `tailscale whois` on the request's address and refuses any other device. Only its SHA-256 is kept (`data/machine-joins.json`, 0600); one code per machine, a new one replaces it; `remove_machine` drops it | Creating it is `add_machine`, a user-asked tool that runs only for a person's own words, and `join_code` also requires an owner (`ownerOnlyProblem`, as owner-only settings do): the same guarantee as today. The code is shown in chat once, so the device binding is what makes a copy useless: an agent that read it on another machine is refused (its whois names another device), the code dies at its first use, and it lapses in an hour. The credential itself goes from the portal to a file on the PC over the tailnet's HTTPS, never through chat |
| Where the join is answered | Tailnet only: `/machine/join` and `/join/*` refuse a Funnel request (`Tailscale-Funnel-Request`) and any address outside the tailnet (`tailnetOnly`, as the orchestrator chat does); 10 wrong codes from one address in 15 minutes and it answers 429 | The portal is also on the public internet through Funnel, and the new PC is on the tailnet by definition |
| The tailnet (w1592, retired by w1596: no tailnet change is needed now) | The tag `tag:fff-worker`, granted port 22 from `tag:fff-portal` once in the policy; the bootstrap offered `tailscale login --advertise-tags=tag:fff-worker` (a tag owner's browser sign-in) only when the portal's ssh does not get in, and never with `-Yes`; otherwise it prints the admin console step | Only a tag owner or admin may apply a tag, and the CLI needs a sign-in to do it ([Tailscale: tags](https://tailscale.com/kb/1068/tags): "To assign tags to a device using the CLI, run `tailscale login` command with the `--advertise-tags=tag:<tag-name>` flag"; `tailscale set` has no such flag, [CLI](https://tailscale.com/kb/1080/cli)). A tagged device's key expiry is off by default, which removes the "Disable key expiry" step. But a tagged device leaves its user's identity ("Applying a tag to a device previously authenticated with a user account removes the user account"), so the `autogroup:member` grants stop covering it: the policy block gives `tag:fff-worker` the same reach a member device has. Naming each PC in the grant, as today, still works and needs an admin each time |
| Default limits | Unity editors: one per 16 GB of RAM above 8 GB and per 4 logical CPUs, 1 to 4. Sandboxes: editors + 1, at most one per 60 GB free on the root's drive, 1 to 8. Agents per sandbox: 2. No RAM figure: the installer's 3, 2, 2. A limit the owner gave with the code wins; one given at the PC wins over both; `add_machine` and `machine_update` change them later | A guess built on measurements: four Unity processes building took about 45 GB on LothDesktop's 64 GB (w469, [unity-lifecycle.md](unity-lifecycle.md#unity-slots-every-editor-counts)), about 12 GB for an editor with its build; a sandbox takes 15 to 125 GB (w511, above); a Claude process about 0.6 GB (portal-on-ffbox-host.md). 64 GB and 24 CPUs give 3 editors and 4 sandboxes, what LothDesktop runs |
| Rerun | An installed PC updates with no code; a waiting record is reused; an installed id refuses a code ("run the bootstrap on it again"); an ssh-deployed id refuses one too (migrate it) | One record and one credential per machine; a code for an installed machine would only cut its daemon off |

**What it never does**: print or log a credential (the portal logs the code's and the credential's last four only), put the
code on a command line (it is typed at a prompt, which PowerShell keeps out of its history, or set as `FF_JOIN_CODE` inside
the downloaded `.cmd`, which only that window sees), install a Unity editor, change the tailnet policy, make an ssh key, or
delete anything but the folder it made. The downloaded `.cmd` stays in the Downloads folder (deleting it would be a delete
outside the worker install folder); the code in it is spent at the join and lapses within the hour anyway. Since w1596 it
turns on no OpenSSH Server and adds no firewall rule for it; a PC that joined before keeps the ones it has (OpenSSH Server
and the `FFFactory-sshd-tailnet` rule stay after an uninstall too: a Windows feature the person may use; remove them by hand
if not wanted).

**Tests**: `server/machineJoin.test.ts` (codes, hashes, expiry, defaults, whois), `server/machineJoinHttp.test.ts` (tailnet
only, device binding, check versus redeem, one use, throttle, dry-run portal), and `scripts/join.test.ts`, the dry run
against a test enrolment: both bootstraps against a local portal running the real join routes, with a fake tailscale and a
fake installer. A `-DryRun` leaves the code unused; a join hands the installer a private credential file that is gone
afterwards, the credential and the code never reach the output, and the code then fails; a second run on an installed PC
updates it with no code. On the Windows job (.github/windows-tests.txt) the same file also runs join.ps1 under Windows
PowerShell 5.1 and the downloaded installer under cmd.exe, as a double-click runs it: CRLF, the quoting, `irm | iex` with
its code, and the message when the portal cannot be reached. `server/machines.test.ts` covers `createJoin`. The
Windows-only steps (winget, the Dev Drive) and the Mark-of-the-Web warnings run for the first time on a real PC.

#### The download and Windows' warnings (w1592)

The installer is `ff-factory-join.cmd` (`scripts/worker/join.cmd`): a batch file that downloads the bootstrap above with
`curl.exe` to `%LOCALAPPDATA%\FFFactory\join\join.ps1` and runs that file in Windows PowerShell (`-File`, with
`FF_JOIN_CODE` set when the dashboard wrote it in). Double-clicked, or run from a Command Prompt or PowerShell, elevated or
not: an administrator window of the person signed in installs for that person (`install.ps1 -Owner`, so the files and the
daemon's task are theirs and the daemon runs unelevated); another account's administrator window is refused, since the
install would belong to that account.

**Never `powershell -Command "irm <url> | iex"` on a command line** (w1603). The first installer did that, and on
desktop-coosego (Windows 11, run from an administrator Command Prompt in Downloads) it printed only `Access is denied.`,
the very first line, before any line of join.ps1. That is cmd's message when Windows refuses to start a process, and the
`powershell.exe` line was the only command in the file that starts one. Microsoft Defender blocks a child PowerShell whose
command line downloads and runs a script, as `Trojan:Win32/Commando.A!ml`, and the caller sees `Access is denied`
([a Windows 11 report of exactly this](https://github.com/Thurbeen/fleet/pull/139); sourced, not reproduced here: CI's
Windows runners do not run Defender's real-time protection). The same line typed into a person's own PowerShell is not a
child's command line, so the dashboard's PowerShell line stays. `scripts/join.test.ts` fails on a download-and-run
command line in `join.cmd`, `join.ps1` or `install.ps1`; join.ps1's Claude Code step downloads `install.ps1` to a file too.

**What a failure says** (w1603): every line join.ps1 and the installer print goes to `%LOCALAPPDATA%\FFFactory\join\join.log`
too, named on screen at the start and the end; the code and the credential are never printed, so never logged. The .cmd
names its own two steps (the download, PowerShell), and join.ps1 names the step it stopped at with the error. The
"is this PC connected to Tailscale" hint shows only when the portal cannot be reached: the download failed to connect, or
join.ps1 exited 3 (Tailscale not connected, or `/api/health` unanswered). When PowerShell never started join.ps1 (the .cmd
writes "waiting" to `started.txt` beside the log and join.ps1 overwrites it first thing; a run id would not do, since two
cmd.exe started in the same second get the same `%RANDOM%`), the .cmd says Windows blocked it and to look in Windows
Security's Protection history.

A `.cmd` rather than an `.exe`: it needs no build or compiler on the portal, a person can read it before running it,
the dashboard writes the code into it in the browser (`windowsInstaller`, server/machineJoinHttp.ts), and an unsigned
`.exe` meets the same warnings below. A file a browser downloads carries the Mark of the Web, and Windows then does this:

| On the PC | Unsigned `.exe` | This `.cmd` | The PowerShell line |
|---|---|---|---|
| SmartScreen (the usual setting) | "Windows protected your PC": More info, Run anyway | a warning to click through, Run [guess: to be seen on desktop-coosego] | no file, no warning |
| Smart App Control on | blocked, no override | blocked, no override | runs [guess] |

Sources: Microsoft's [Smart App Control has blocked an app with a dangerous file extension](https://support.microsoft.com/en-us/topic/smart-app-control-has-blocked-an-app-with-a-dangerous-file-extension-60343058-66f2-4548-b978-e484e13abe89)
lists `.bat`, `.cmd` and `.ps1` among the downloaded files it blocks; its [What is Smart App Control](https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003)
says an app the cloud cannot vouch for runs only with a valid signature and has no per-app override; Eric Lawrence's
[Smart App Control](https://textslashplain.com/2026/04/28/smart-app-control/) says it starts in evaluation mode on a new
install, its block "does not offer an override", it turns SmartScreen's app reputation off while on, and a signature must
chain to Microsoft's Trusted Root program. So on a PC with Smart App Control on (Windows Security > App & browser control >
Smart App Control) the download cannot run: use the PowerShell line, which the dashboard shows beside the download.

**Code signing** (a person's decision: it costs money; nothing is bought here). A valid signature lets the installer past
Smart App Control; SmartScreen still warns about a newly signed file until it has a download history, and since 2024 an EV
certificate no longer skips that ([Microsoft: code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options):
Artifact Signing "works like OV certificates"). A `.cmd` cannot carry a signature (Authenticode covers `.exe`, `.msi` and
`.ps1`, not batch files), so signing means an `.exe` installer, signed once in CI, that reads its code from its own file
name (`ff-factory-join-<code>.exe`), since writing the code into the file would break the signature. The cheapest route is
Microsoft's Artifact Signing (formerly Trusted Signing), about $9.99 a month per that page: organisations, and individuals
in the USA and Canada only, after an identity check of a few business days (a third-party post says individual onboarding
was paused in March 2026; Microsoft's page does not say so). Without it, the `.cmd` and the line cover every PC: one warning
click with Smart App Control off, the line with it on.

### Updates over the daemon's link (w1596)

lothsahn, 2026-10-20 (w1596): "Yes, move updates and restarts onto the daemon link; drop the SSH need". The daemon's link is
outbound (its WebSocket to the portal, `machine/daemon.ts`), so a PC on a tailnet login whose policy does not let the portal
reach its port 22 (desktop-coosego) can now be updated, restarted and unloaded all the same:

1. **The portal sends `self_update`** (`server/machines.ts` `linkUpdate`) only to a daemon whose hello offers `selfUpdate`: a
   worker root install whose `root.json` names its service (`machine/selfUpdate.ts`). The message carries the commit, the
   form (`update`, or `tools` for the agent tools), the settings named, and the SHA-256 and size of a **git bundle of the
   portal's own checkout** at its HEAD (`server/machineLink.ts` `UpdateBundles`: a release is a worktree of a full clone,
   deploy/vm/guest/fff-update; a shallow checkout is refused, since its bundle cannot be fetched). The bundle is made once per
   commit in `data/update-bundles`, the two newest kept. So a machine updates to exactly the code its portal runs.
2. **The daemon checks it before anything runs.** It downloads `GET /machine/update/<sha256>` with its own credential (the
   portal serves only the bundle it offered that machine, for an hour), checks the size and SHA-256 against the message (which
   came on its own authenticated link), runs `git bundle verify`, fetches it into the install's checkout `<daemon>/src` (git
   checks every object), checks that the bundle's HEAD is the commit named, and checks it out. A mismatch is refused with
   the reason (`self_update_ack`) and changes nothing. A download that stalls (30 s without a byte) or breaks resumes from
   the bytes it has with a Range request, up to 6 tries within 8 minutes, each logged in the daemon's log with its cause
   (`machine/selfUpdate.ts` `DOWNLOAD`; w1641: beast's stalled at 7 of 18.5 MB and Node's fetch sat 300 s before it said
   "terminated"). The portal waits 12 minutes for that answer (`LINK_ACK_MS`), and logs one that comes later with its reason.
   An answer the link could not carry (it was down, or it was sent less than a minute before a drop, since a dead link
   looks open for up to 45 s) is kept 30 minutes and sent again after the next hello (`ANSWERS`; w1641: at the 450f7d53c
   rollout the portal VM's Tailscale restarted 4.5 minutes into beast's update). The portal ignores a repeat, takes a
   job's report as the answer too, and logs every bundle it serves: `machine <id>: the update bundle went out in <t> s`,
   or `was cut after <n> of <size> bytes`.
3. **The job runs outside the daemon**: `<daemon>/update/job.json`, and `scripts/worker/linkJob.ts` from that commit,
   started as the OS's own (`machine/osJob.ts`), since a daemon restart ends everything the daemon started but its agent
   hosts (`Stop-FFDaemon`): the scheduled task `<service>Job` on Windows (this user, interactive, not elevated, headless, four
   hours at most, also at logon), the LaunchAgent `<label>.job` on a Mac (run at load, not kept alive), a transient
   `systemd-run --user` unit on Linux. Its output goes to `<daemon>/logs/update-job.log`.
4. **The update is the installer's own**: `worker.ts update --source <daemon>/src` with only the settings named, as the ssh
   path runs it (prerequisites first; every setting, the credential and the PATH carried; `app.new` swapped in with the old
   code kept as `app.old`; the daemon restarted; agents run on in their hosts and the new daemon adopts them, w605). It
   waits for the portal to see the new commit online, restarting once.
5. **It puts the old code back by itself**: when the portal does not see the new daemon online, not outdated, on the new
   commit, the job moves the new code to `app.failed` and `app.old` back to `app`, restarts the daemon (its agents run on)
   and waits up to 3 minutes, restarting once after one, for the portal to see the old commit online. A job a reboot cut off
   starts again at logon and only checks and puts back. The job is the watcher outside the daemon's process that the
   request asked for.
6. **The report**: `<daemon>/update/result.json`, sent by the daemon that runs afterwards (`self_update_report`, the new one
   or the old one put back); then the job's task or LaunchAgent is removed. The report carries the installer's lines
   (`Before:`, `After:`, any `~ key: before -> after`), never a credential (any `ffm_` token is cut to its machine id).

**Who uses it.** The rollout after a verified deploy, for the daemon step and the agent tools ([ops-worker.md](ops-worker.md#after-a-verified-deploy-w887));
`ops_worker machine_update`, which the portal then runs itself (no ssh, no worker job) and reports to the caller's
orchestrator as a `[machine update]` message; `machine_daemon restart` (`daemon_control restart`: the daemon answers, exits,
and its supervisor starts it again, its agents running on); and `remove_machine` (`daemon_control uninstall`: a job unloads
the daemon as the ssh path did, its supervisor stopped and unregistered, its agents ended, its files kept).

**ssh stays** for a daemon from before w1596 (its hello offers no `selfUpdate`: the next update, over ssh, brings one that
does), one that is not connected (`machine_daemon start` of a stopped daemon; the rollout's put-back over ssh when a job
never reports and the machine stays offline, where ssh reaches), the portal's own host, ssh-deployed machines (not worker
roots), and the ops worker's diagnosis. A daemon that does not come back even after its job put the old code back needs
someone at the PC; the report says so ("it needs a person"), as the ssh path's did.

**Security.** Only the portal sends these, on the machine's own link, which the portal accepts only with that machine's
credential; the bundle goes only to the machine it was offered to; the code is checked against the SHA-256 and size the link
gave and the commit git computes, before anything runs; the job runs as the daemon's own user, never elevated; nothing is
printed or logged with a credential in it.

**The install record has a spare copy, and a connected daemon is never sent to ssh** (w1918). LothLaptop's V: was reset to
an empty drive on 2026-10-23. `V:\ffw\root.json` went with it, the daemon on D: offered no update in its hello, and
machine_update and the rollout handed out ssh to a PC that joined without it: port 22 timed out, and nothing said why
(lothsahn: "Make sure you can do updates over the machine protocol"; "Let's do the root.json backup and have the daemon be
smart enough to automatically reinstall it in v: if the V: ever gets reset"). Now:

- **The spare copy.** Every manifest write also writes `root-backup.json` in the daemon's folder (`worker.ts` `writeManifest`),
  which for a root on its Dev Drive is the host folder (`D:\work\ffw\daemon`). The daemon also keeps that copy in step with
  `root.json` every 10 s (`machine/selfUpdate.ts` `keepRootJson`), so an install from before this gets one at its first start.
- **The put-back.** For a root on its Dev Drive (`devDrive.rootOnDrive`), the daemon puts `root.json` back from the spare
  copy when it is missing or unreadable. It does so before its hello, before each update or unload over the link, and every
  10 s once the drive is there again, making the root's folder again if needed. A drive that is not attached cannot be
  written to, so the next look tries again. The repo and the sandboxes are made again afterwards: the next update clones the
  repo, and the pool remakes each free sandbox whose folder is gone ("The whole root on the Dev Drive" below).
- **No silent ssh.** A daemon that is connected but offers no update over its link (no `root.json` and no spare copy) is
  neither updated nor handed to ssh. machine_update refuses, and the rollout marks it failed. Both name the file that is
  missing and what to do (`server/machines.ts` `linkProblem`). ssh stays the way back only for a daemon that is not connected.
- **`readManifest` ignores a UTF-8 byte order mark**, so a hand-written `root.json` saved by PowerShell 5.1's `Set-Content`
  reads as JSON.

**Tests**: `server/machineLink.test.ts` (a real daemon and portal over WebSockets: the update and its report, a second one
refused while a job runs, a failed one put back, who may fetch the bundle, a wrong size, SHA-256 or commit refused, a
restart, an unload, a daemon outside a worker root left to ssh), `scripts/worker/linkJob.test.ts` (the job: an update, a put
back, a put back that cannot move the folders or does not come online, a reboot, the tools and unload forms, the OS job's
task XML, LaunchAgent and systemd-run line), `server/machineRollout.test.ts` and `server/opsWorker.test.ts` (the link path,
with no ssh at all), and `scripts/worker/test/link-e2e.ts` on CI's real Windows and macOS runners (worker-update.yml): the
real installer, supervisor, daemon and job, an update, one whose daemon exits at start and is put back by its job, a
restart and an unload.

### The tailnet (w1592)

Since w1596 a PC that joins with a code needs nothing here: the portal updates it over its daemon's link. The block below is
only for a machine the portal should also reach over ssh (the ops worker's diagnosis, or a daemon from before w1596). The
portal reaches machines over ssh only through the tailnet policy's `tcp:22` grant from `tag:fff-portal`; a tailnet admin
adds this once (Access controls; [RUNBOOK](../deploy/vm/RUNBOOK.md) section 1 has the
rest of the policy). `<owner logins>` are the people who may tag a PC at its join (an admin always may):

```jsonc
"tagOwners": { "tag:fff-portal": ["autogroup:admin"], "tag:fff-worker": ["autogroup:admin", "<owner logins>"] },
"grants": [
  // ...the grants already there, then:
  // a tagged worker keeps what a member device had: people's devices reach it, it reaches them and the other workers
  { "src": ["autogroup:member", "tag:fff-worker"], "dst": ["tag:fff-worker"], "ip": ["*"] },
  { "src": ["tag:fff-worker"], "dst": ["autogroup:member"], "ip": ["*"] },
  // it reaches the portal's HTTPS
  { "src": ["tag:fff-worker"], "dst": ["tag:fff-portal"], "ip": ["tcp:443"] },
  // and the portal reaches it over ssh, and nothing else
  { "src": ["tag:fff-portal"], "dst": ["tag:fff-worker"], "ip": ["tcp:22"] }
],
"tests": [ { "src": "tag:fff-portal", "accept": ["tag:fff-worker:22"], "deny": ["tag:fff-worker:443"] } ]
```

Then an admin tags the PC in the admin console (Machines, the PC, Edit ACL tags); the bootstrap no longer offers it. Without the block, an admin names the PC in the existing grant instead and
turns off its key expiry, as for the machines added before.

### Updating

**A portal update does not need a worker update** (w605). The portal and the daemon are versioned by their protocol
(`server/machineProtocol.ts`), not by commit: a daemon from another commit whose protocol the portal drives (7 and up
today) shows "update available" and keeps taking, starting and resuming agents ([machines.md](machines.md),
"Versions"). The portal says once, in a `[machines]` line, that an update is available. Only a protocol out of range
(outdated) stops new agents there until the install is updated.

**Over the daemon's link first** (w1596): a worker root machine whose daemon offers it is updated by the portal itself,
[Updates over the daemon's link](#updates-over-the-daemons-link-w1596); everything below is the ssh path, which stays for a
daemon from before w1596 and one that is not connected. **The ops worker runs the update, and any installer rerun; a person never does** (lothsahn, 2026-10-10, w855: "don't ask ben to run installers.  Update your instructions.  Stop doing that.  When we say update the machines, do the update, including installers if necessary"). The commands below are what [the ops worker](ops-worker.md#updating-and-re-running-a-machines-installer-w855) types over ssh. A request that needs one (a daemon update, a sandbox count, an agent or editor limit, a reinstall) is sent to it by the requester's orchestrator, with `ops_worker machine_update` (`machine`, `max_sandboxes`, `max_agents_per_sandbox`, `max_unity`, and the `work_id` of the person's own open request that asks for it). The dispatcher and the orchestrators never ask a person to run these. **After a verified portal deploy the portal runs this update itself on every worker-root machine** (w887, [ops-worker.md](ops-worker.md#after-a-verified-deploy-w887)): no request, no `machine_update` call, no setting named, and the machines that were offline follow when they come back. The same rollout then publishes the latest agent tools on each of them ([The agent tools](#the-agent-tools-w1476), w1476).

**To update a worker, run its update** (w613). It is one command. It asks nothing, so it runs the same at the machine and
over ssh (the orchestration worker's path, [ops-worker.md](ops-worker.md)). It is as safe to re-run as the install:

```bash
# a Mac, as the account the daemon runs as (locally, or over ssh with no keychain):
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --update --root /Users/Shared/ffw
# from a checkout of ff-factory instead:
bash scripts/worker/install.sh --update --root /Users/Shared/ffw
```

```powershell
# Windows, as the account the daemon's task runs as: a normal PowerShell, or an ssh session (elevated or not):
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) -Update -Root D:\ffw
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\worker\install.ps1 -Update -Root D:\ffw
```

Both run `node scripts/worker/worker.ts update --root <root>`. What it does (each from what the ops worker hit
reinstalling beast and m5 on 2026-10-07, f3f19c0 → 9ea8476):

- **It asks nothing and reads the install.** `root.json` gives the machine, the portal, the service name and the
  repo, and `daemon.json` gives the settings. **The credential** is the machine's own `secrets/machine-token`: nothing is
  asked for, issued or printed, and no `--credential-stdin` is needed. Before, a plain re-run needed the credential
  piped in.
- **It carries every setting.** The update uses the migration's `carry` (`planUpdate`, `daemonJson`): BEAST's 6-agent
  total, protected paths, the Library seed and block clone, below-normal editors, the disk guard, cleanup, the Unity
  paths and the test-install options. `--max-sandboxes`, `--max-agents-per-sandbox` and `--max-unity`
  (`-MaxSandboxes`, …) change only what they name. It prints the settings that changed, `~ key: before -> after`.
  Before, a plain re-run rewrote `daemon.json` and dropped the tuned settings.
- **It fetches nothing of the game repo.** The root's clone is kept as it is, and the daemon fetches with the user's
  own credentials when it next makes a sandbox. Over ssh a Mac's login keychain is out of reach, and the install's
  `git fetch origin` failed on m5 for that reason.
- **The daemon code** is ff-factory, which is public. It is fetched anonymously into the root's `daemon/src`, with no
  credential helper and no prompt, at **the commit the portal runs** (`/api/health`), so the daemon matches its portal.
  `--daemon-ref main` (`-DaemonRef`, or `--ref` for `worker.ts`) takes another ref. `--source <checkout>` (`-Source`)
  installs from a local ff-factory checkout with no download at all. If the fetch fails, the update stops before it
  changes anything and says so.
- **On Windows, an elevated session is fine.** An administrator's ssh session is always elevated (BEAST's was). The
  update gives what it makes to the user the daemon's task runs as (`icacls /setowner`, the install's `--owner`, as the
  portal's ssh deploy does). It refuses when the task runs as another user than the session's. The install's guard
  against elevated runs stays: its purpose is that files an elevated shell makes belong to Administrators and the
  daemon's non-elevated git then refuses the clone. Giving them back to the task's user is what removes that risk.
  An administrator prompt nobody can answer (a session that is not elevated and has no console) is skipped: the
  firewall rules and the portal's key that the install made stay. The firewall rules and the portal's ssh are kept
  as the install made them (`root.json` lists both); `--no-firewall` and `--no-ssh` leave them out.
- **On a Mac, the PATH keeps its order.** The new LaunchAgent plist keeps the old plist's PATH entries first, in their
  order, and adds only folders that are new. m5's `~/.unity/bin` had moved to the end. On Windows the task carries no
  environment of its own (its XML has a user and an action only), so there is nothing there to keep. The task's user
  stays.
- **It checks every prerequisite before it touches anything** (w629). git, git-lfs, node, Claude Code, the portal,
  the limits: all are checked before the code is fetched and before the daemon is stopped. On a failure the daemon
  keeps running what it ran, untouched, and the update exits 2 with each problem and "the daemon was not touched".
  On m5, on 2026-10-07, a run that found no git-lfs still restarted the daemon and then reported success.
- **It finds the tools where they live, off an ssh session's PATH** (w629). A non-interactive ssh session's PATH is
  short (m5's `ssh benryding@m5` had `/usr/bin:/bin:/usr/sbin:/sbin`, and git-lfs 3.7.1 was in `/opt/homebrew/bin`).
  The installer adds the standard folders that exist and are missing, for its own run only:
  - on a Mac, `/opt/homebrew/bin`, `/opt/homebrew/sbin` and `/usr/local/bin`, first, as a shell has them;
  - on Windows, Git for Windows (`Git\cmd`, `Git\mingw64\bin`) and `nodejs` under Program Files, last;
  - Claude Code's own folders, last: `~/.local/bin`, and on Windows npm's `%APPDATA%\npm` too.

  This is `install.sh`, `install.ps1` and `worker.ts withStandardPaths`. The daemon's own PATH is not this: it is the
  LaunchAgent plist's, from the user's login shell (kept in its order, above), and on Windows the user's logon
  environment.
- **It restarts the daemon, and succeeds only on the commit it installed.** The install stops the old daemon (its
  agents keep running in their hosts, below), installs the new code and starts it. If the install stopped before the
  new code was in place, nothing is restarted and the update fails, saying which code the daemon has. Otherwise it
  waits until the portal sees the machine online running the commit installed (`/machine/whoami` reports the daemon's
  commit and whether it is outdated, a portal from w613 on). If the portal does not, it restarts the task or
  LaunchAgent once (the ops worker had to run that by hand on beast) and waits again. It ends with:
  - what ran before and after;
  - the settings changed;
  - the credential reused;
  - what the portal sees.

  **Exit 0 only when the portal sees the daemon online, running that commit, and not outdated**
  (`updateVerdict`). Anything else exits 1 and says what the daemon runs: "m5's daemon still runs 9ea8476, not
  22b5f8b…". A portal that does not report the daemon's commit confirms nothing, so that also exits 1.

**An update does not stop running work** (w605). Each agent process runs in an agent host of its own
(`machine/agentHost.ts`), started detached from the daemon, so it outlives the daemon ([machines.md](machines.md),
"Agents outlive their daemon"). The update (and a re-run of the install) stops only the daemon and its supervisor (`Stop-FFDaemon` without `-Agents`
on Windows, `launchctl` on a Mac). Agents mid-turn carry on: their shells, builds and players keep running, and so do
idle agents' processes. Unity editors keep running as before. The new daemon finds the hosts in
`<root>\daemon\hosts\`, takes them back, forwards to the portal whatever they recorded meanwhile, and their turns
report to the portal as if nothing happened. An agent whose host is gone (the computer restarted, it crashed) is resumed
by the portal with its conversation (`claude --resume`) if it was mid-turn, and otherwise on its next message.

- **The first update onto this version still stops running agents**: a daemon from before w605 runs its agents
  inside its own process, so they end when it stops. The portal resumes the mid-turn ones as before; idle ones show
  stopped and come back on their next message. Every update after that keeps them.
- A stop (`machine_daemon stop`, or `Stop-FFDaemon -Agents`) and the uninstall still end the agents.

Measured on BEAST (2026-10-07), with a throwaway install (`-Service FFW605Test`, a scratch root, a tiny game repo)
against the throwaway portal (`scripts/worker/test/portal.ts`, which can now start a worker: `POST /agent`) and real
Claude Code agents on BEAST's own login:

1. Installed from ff-factory main at 7162d69 while the portal ran ca4a133 (same protocol 8): the machine showed
   "update available: it runs 7162d69, this portal ca4a13329", and a new agent there started and answered.
2. Re-ran the installer from ca4a133 (the first update onto agent hosts): it took 11 s, and the old daemon's idle agent
   ended with it, as expected.
3. A new agent started a 100 s command (Claude Code put it in the background). Re-running the installer took 12 s. The
   new daemon logged "agent host 9658a61e (pid 58208) adopted: idle, live", and the command's end woke the agent in the
   same process, which went on and reported "DONE-W605" to the portal with no resume message.
4. The same agent ran a 100 s command in the foreground, and the installer ran again (9 s) during it. The new daemon
   logged "adopted: running, live". The command printed its line, and the agent answered "DONE-FOREGROUND" from the
   same host process. The transcript's 22 events are in order, none twice.
5. The uninstall ended the host and left nothing of the install ("Nothing of the wtest install remains").

**An agent whose process did end keeps its sandbox** (w613). This covers the first update onto agent hosts, a computer
restart, and a crash. The portal marks the agent `heldSince` when its daemon goes away under it, and `list_sandboxes`
shows it "Stopped (its daemon restarted at …; its sandbox is kept for it until …)", not FREE. New work does not take
that sandbox until the agent is messaged, `stop_agent` releases it, the new daemon takes the agent back alive, or 30
minutes pass (`HOLD_PLACE_MS`; a day until w656). After that the release pass releases the sandbox when the worktree is
clean and places the agent again when it resumes (docs/machines.md, "Released sandboxes"). A dirty worktree keeps the
sandbox held, and `list_sandboxes` says why. On LothDesktop at 08:29 UTC on 2026-10-07, the update stopped Ben's 77956901, which had no
check-in, and slot2 showed FREE.

### The agent tools (w1476)

Lothsahn, 2026-10-18: "Please create a new work item that deploying the latest tools is part of every deploy operation".

**TL;DR:** the installer's `-Tools` (`--tools`) form brings Claude Code's ff-agents, ff-speckit and ff-discord plugins on
this machine to final-factory-agents master, from FF Factory's own checkout in `<root>/tools`, and changes nothing else.
The portal runs it on every worker-root machine after every verified deploy ([ops-worker.md](ops-worker.md#after-a-verified-deploy-w887)).

Before it, nothing in FF Factory ran `registerAgents.sh`: ff-agents 1.29.20 (final-factory-agents #243, w1469) merged at
19:14 UTC on 2026-10-18 and BEAST still loaded 1.29.19 from a marketplace clone at 9039e82 (measured) until the ops worker
ran it by hand.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) -Tools -Root D:\ffw
```
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --tools --root ~/ffw
```

What `worker.ts tools` does (`server/agentTools.ts` `publishAgentTools`):

1. Prints `Agent tools before:` with the versions in `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json`,
   the folder the machine's workers read (BEAST's leave `CLAUDE_CONFIG_DIR` unset, [worker-root.md](worker-root.md)).
2. Clones `https://github.com/Final-Factory/final-factory-agents.git` into `<root>/tools/final-factory-agents` the first
   time (anonymously: the repo is public and an ssh session reaches no keychain), and after that fast-forwards it to
   origin/master. **It never uses a person's checkout** (BEAST's `~/final-factory-agents`, on a branch of its own today):
   Claude Code installs plugins from its managed marketplace clone (`~/.claude/plugins/marketplaces/final-factory-agents`),
   which `registerAgents.sh` refreshes from GitHub, so any up-to-date copy of the script will do. If its own checkout has
   uncommitted changes, is on another branch, has another origin or cannot fast-forward, it prints `NOT PUBLISHED: <why>;
   nothing in it was overwritten`, exits 3 and leaves it: no reset, stash or branch switch.
3. Prints `Agent tools latest:` with the commit and master's versions (its `.claude-plugin/marketplace.json`).
4. Runs `sh registerAgents.sh --claude` there (Git Bash's `sh.exe` on Windows, found from `git --exec-path`), with the
   daemon's Claude Code (`daemon.json` `claude`) first on PATH: the marketplace pulled, every plugin the machine remembers
   updated. That is ff-agents and ff-speckit everywhere, and ff-discord only where a person ran `--plugin ff-discord`
   (registerAgents.sh's `~/.claude/final-factory-agents-plugins`); a bare run never adds it. Codex is not touched.
   Claude Code fetches the marketplace over HTTPS only (`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`) with a five-minute git
   timeout (`CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS=300000`), and a run that fails (but did not time out) is run once more
   (w1895, `REGISTER_ENV` in `server/agentTools.ts`). Without that, Claude Code picks SSH wherever `ssh -T git@github.com`
   authenticates (m3: bryding's key) and HTTPS elsewhere, falling back to the other one: on m5, whose key is on no GitHub
   account, a failed HTTPS fetch fell back to SSH and the step said only "Please make sure you have the correct access
   rights" (2 of 14 rollouts on 2026-10-23).
5. Puts back publish-skills' marker `~/.claude/final-factory-agents-checkout` if `registerAgents.sh` pointed it at the
   tools checkout, so a person's skill edits keep going to their own checkout. With no marker before, the new one stays
   and the output says so.
6. In an elevated Windows session (an administrator's ssh, BEAST), gives the checkout and Claude Code's
   final-factory-agents marketplace and cache folders to the daemon task's user (`icacls /setowner`), as the update does,
   so the non-elevated git there does not refuse them.
7. Prints `Agent tools after:` and exits 0 only when every installed plugin is on master's version and ff-agents and
   ff-speckit are installed; else `FAILED: ...` and exit 1.
8. Windows: puts the agents' node, the pinned `AGENT_NODE` build (`server/agentNode.ts`, v24.22.1, its SHA-256 checked),
   at `<root>\tools\node\node.exe` unless that one is there (`Agent node: ... (current)`), and the daemon puts that folder
   first on its agents' PATH after `unity-slot` (w1742). FF Factory's own tests need node 23.6+; before this, workers on a
   machine with an older node unpacked one into their session temp folder, a new program path each session, and Windows
   Firewall asked about each one (lothdesktop kept rules for three `V:\ffw\tmp\ffa-*\` node.exe paths, 2026-10-12..20). A
   new version replaces the folder's contents, never its path, so the install's rule for it keeps fitting; a node still
   running from the old folder leaves it for the next rollout (`... is in use`). A failure prints `WARNING: Agent node:`
   and does not change the exit code.
9. Windows, when the install made firewall rules: reads, without admin rights, whether each player slot and the agents'
   node has an enabled inbound allow rule for its exact path, and whether rules earlier prompts left under `<root>\tmp`
   remain (`firewallCheckScript`, two bulk reads, 4 s on lothdesktop's 696 rules). All there: one `Windows Firewall: ...
   are there.` line. Something missing and the run elevated: runs `firewall.ps1` as the install does and records the node's
   group in root.json. Not elevated: `WARNING: Windows Firewall: ...`, and the exit code stays. A daemon update and a tools
   run over the daemon's link are never elevated, so the node's rule from #517 reached no machine (w1742); the rollout
   therefore reruns the tools form over the portal's ssh (elevated for an administrator's account,
   administrators_authorized_keys) when a run over the link warns of a firewall rule, and the report carries any
   warning that remains (`Agent tools: ... WARNING: ...`).

Running agents keep the plugin version they started with (its cached copy stays on disk); new sessions load the new one.
No agent is stopped or waited for.

Tested: `server/agentTools.test.ts` (fake git and sh), and by hand on BEAST on 2026-10-18 with `HOME` and
`CLAUDE_CONFIG_DIR` in a temp folder: a first run installed ff-agents 1.29.20 and ff-speckit 1.0.2 (exit 0), a second
kept a person's marker, a record set back to 1.29.19 was updated to 1.29.20, a stray file in the checkout gave
`NOT PUBLISHED ... (1 path)` and exit 3, and `install.ps1 -Tools -Root <fake root>` ran the same (exit 0).


### The Dev Drive (w900)

**TL;DR:** A new Windows install makes a **Dev Drive** in its root: a dynamically expanding VHDX, `<root>\devdrive.vhdx`,
formatted ReFS as a Dev Drive and mounted at **the first free drive letter from V: down to A:**. The sandboxes and the
Library seed live on it, so every new sandbox's Library is a block clone of the seed (a few seconds and almost no disk)
instead of a 40 to 99 GB copy. It is mounted again at every boot, before the daemon starts, by a SYSTEM task. Re-running
the installer reuses it and never formats or recreates it. (lothsahn, 2026-10-10, w900: "Please modify the installer so
that it does this in the specified location when you request an install. The dev drive file would live there, and the dev
drive would grab a new file letter starting with V: and moving back towards A until it finds an available drive letter.")

**Why** (w900; sizes from w892 and w628, measured): LothDesktop's `D:` is NTFS and holds other data, so it cannot be
reformatted (lothsahn: "Is there a way to do this on NTFS because the drive has other data and I can't just reformat
it"), and each of its six sandboxes carries a whole Unity Library (BurstCache alone is about 32 GB). BEAST has had the
same thing since w466 as a hand-made VHDX (`scripts/devdrive.ps1`, `C:\ffsb-devdrive.vhdx` mounted as `F:`); this
generalises it, and BEAST keeps its own.

| | |
|---|---|
| **When** | A **new** install on Windows makes one unless `-NoDevDrive` (`--no-dev-drive`). An **update** makes none unless `-DevDrive`: the portal runs updates by itself after every verified deploy ([ops-worker.md](ops-worker.md#after-a-verified-deploy-w887)), and a drive made in the middle of work is not what an update is for. An install that has one keeps it on every update. A root already on a ReFS volume (BEAST's `F:`) needs none and gets none. |
| **Flags** | `-NoDevDrive`; `-DevDrive` (update: make it if missing); `-MoveToDevDrive` (update: also move the existing sandboxes, below); `-DevDriveMaxGB N`; `-DevDriveSkip U,T` (letters it never takes). `worker.ts`: `--no-dev-drive`, `--dev-drive`, `--move-to-dev-drive`, `--dev-drive-max-gb N`, `--dev-drive-skip U,T`. `ops_worker machine_update` takes `dev_drive`, `move_to_dev_drive` and `dev_drive_max_gb` for a Windows PC. |
| **The file** | `<root>\devdrive.vhdx`, made with `diskpart` (`create vdisk … type=expandable`: no Hyper-V tools needed), GPT, one partition, `Format-Volume -DevDrive -FileSystem ReFS`. The file starts at about 360 MB (measured on GitHub's Windows runner, 64 GB maximum) and grows as the drive fills. `devdrive.json` beside it records letter, maximum, file system, whether it is a Dev Drive format and whether the volume reports block cloning. |
| **The letter** | `V:`, `U:`, `T:` … `C:`, then `B:`, then `A:`; `W:` to `Z:` are never tried (`Z:` is where a share is mapped first). Skipped: a letter **in use** (a volume, a `subst`, a CD drive), a **mapped network drive** (this session's, and every user's persistent mapping in the registry, read from their profiles' hives because the boot task runs as SYSTEM with nobody logged on), a letter **reserved** by Windows (`HKLM\SYSTEM\MountedDevices` remembers the letter of every volume it has seen, plugged in or not), and `-DevDriveSkip`. The install prints which letter it took and why each earlier one was passed over (`V: in use, U: mapped network drive, …`). The rule is one function, `Select-DriveLetter` in `scripts/privileged/devdrive-lib.ps1`, used by the installer and the boot task. |
| **On it** | `<letter>:\sandboxes` and `<letter>:\seed`. `daemon.json` names these (`sandboxes.root`, `sandboxes.librarySeed`, `librarySeedCopy: "clone"`), never the root's junctions: git and Unity record the canonical path ([worker-root.md](worker-root.md) 2.2). `<root>\sandboxes` and `<root>\seed` become directory junctions to them, so tools that look under the root (the uninstall's risk check, `player_slots.py`'s `realpath` of `<root>/sandboxes`) still find the sandboxes. Built players stay in `<root>\players`: the firewall rules name those paths, and a build is hard-linked into a slot only on one volume, so on a Dev Drive root `player_slots.py` copies it (`_link_or_copy`, about 2 GB for a development player, measured in w628) instead. |
| **The seed** | A new install has none: the first sandbox imports its Library cold, and the next ones copy it, as block clones because they share the drive (`librarySource` takes a ready sandbox's Library when there is no seed). A machine that has a seed puts it in `<letter>:\seed\Library`; the move below does that for an existing install. |
| **The guard** | The installer adds a `hostGuard` to `daemon.json` (unless it has one): the daemon watches `<letter>:\sandboxes`, and when it is gone it starts `ffsb-helper-mount` and retries (at once, then 2, 5, 10 and 30 minutes; [self-recovery.md](self-recovery.md), "The sandbox drive"). Its thresholds are the pool's own (`disk_warn_gb` 20, `disk_critical_gb` 10, not BEAST's 80 and 40), it watches the **root's volume** too (`hostDiskPaths: ["D:/"]`: the drive's own "free space" is its maximum size, and a VHDX that cannot grow takes the drive away, BEAST 2026-09-24), and the browser reaper is off. |

**Clean-up and the install folder (w896).** The daemon's clean-up deletes only inside the install folder. The drive's
folders are not under the root, so the installer writes `extraRoots: ["<letter>:\\sandboxes", "<letter>:\\seed"]` into `daemon.json`
and the pass counts them as inside it (`fenceToRoot`, `machine/daemon.ts`); the rest of the drive is outside. A letter change
repoints them with everything else. What is **not** extended: a clean-up worker's shell guard (`server/rootFence.ts`) allows its
own sandbox and the root, so it still cannot delete in another sandbox on the drive; the daemon's pass does that (the
caps of w898 are the daemon's), and a worker reports what it would remove.

**Elevation.** Making and mounting a VHDX needs administrator rights (sourced: Microsoft Learn, "Set up a Dev Drive on
Windows 11": "Local administrator permissions"; BEAST's `devdrive.ps1` is "(admin)"). An **elevated session** (the ops
worker's ssh to LothDesktop and BEAST is, [above](#updating)) does it in place; a normal PowerShell asks once with a
UAC prompt (the same elevated step as the firewall rules). A non-elevated, non-interactive update (an ssh session that is
not an administrator's) cannot make or attach it: with a drive that exists it starts `ffsb-helper-mount` (the daemon's
user may start that task, nothing more) and uses it; with none, it says so and goes on without.
Whether it is attached comes from `devdrive.ps1 -Action status` (`Get-OwnLetter`, `scripts/privileged/devdrive-lib.ps1`),
which needs no administrator: a session that is not elevated gets `Get-DiskImage`'s `Attached` and `DevicePath` but no
`Number`, so the disk number comes from the `PhysicalDriveN` of its `DevicePath` (or from the disk whose `Location` is the
VHDX) and `Get-Partition -DiskNumber` gives the letter. Until w1633 it piped the image into `Get-Disk`, which fails there, and
every automatic update on lothdesktop read its mounted `V:` as "not attached" (2026-10-20; `scripts/devdrive.test.ts`, w1633).

**The boot mount.** `scripts/install-privileged-helpers.ps1` (run by the installer, elevated) copies
`ffsb-helper.ps1` and `devdrive-lib.ps1` to `%ProgramData%\ffsb-helpers` (writable by SYSTEM and Administrators only) and
registers `ffsb-helper-mount` (SYSTEM, **at startup, 30 s after boot**, and on demand), `-trim` and `-compact`. The
daemon's user gets read-and-run on those tasks, nothing more, and the arguments are fixed at registration. The 30 s is
BEAST's: the storage provider refused the attach earlier in the boot on 2026-09-24, so every step retries three times
and falls back to `diskpart`. The daemon starts at the user's **logon**, which comes after; if the drive is still
missing then, the guard waits for it (below). The mount **keeps the letter** (`devdrive.json` says which). If another
claim took it meanwhile, the helper uses the next free letter and **repoints** what holds the old one: `devdrive.json`,
`daemon.json` (`sandboxes.root`, `sandboxes.librarySeed`), the pool's record `daemon\sandboxes.json`, the root's two
junctions and each worktree's recorded path (`git worktree repair`), and writes what it did in `mount.json` and
`mount.log`. Windows keeps the letter of a volume it has seen, so it does not give it to a different volume while
this one is detached (measured on GitHub's Windows runner: `diskpart assign letter=V` for another disk was refused with
"The specified drive letter is not free to be assigned"): what can really take it is a persistent network mapping, a
`subst`, or a first mount on a different PC. An agent that was resumed after a letter change starts in a path with no
conversation under it (Claude Code files them by path; the move below renames them, a letter change does not): that is
the price of a rare event, *a guess* at how rare.

**An update keeps the drive** (w1038). `root.json` carries `devDrive` (letter, size, `inUse`); every install or update builds a
new manifest from the last (`manifestFor`), and the first version left that field out, so the first re-run after a move wiped it and
the next update (the automatic one after a deploy) saw no drive, took none, and wrote `sandboxes.root` and `librarySeed` back to
`<root>\\sandboxes` and `<root>\\seed` (LothDesktop, 2026-10-11, after the 3bc7a07 deploy; its report said "SETTINGS CHANGED although
none was asked for"). Now the record is carried, and a `root.json` that lost it is rebuilt from `devdrive.json` and the VHDX beside
it (`carryDevDrive`; `inUse` when `<root>\\sandboxes` is a junction), so the next update of such a machine puts the drive's paths
back. A settings diff on an update that names no setting is the signal to look for.

**The portal follows the daemon's pool folder** (w1038). A root install's sandbox folder is its installer's, and the daemon's hello
carries its own `daemon.json` pool. `adoptLayout` (`server/machines.ts`) kept the record's folder for a root the portal already knew,
so after the move the portal still said `D:\\work\\ffw\\sandboxes` (the junction) in `list_machines`, `list_sandboxes` and, worse, in every
welcome, which the daemon applies over `daemon.json`: its pool root was the junction path and its seed copy mode was lost (`clone`
is not on the record). Now a hello whose pool folder differs from the record's (same root) replaces the record's folder, seed and
copy mode, and the portal sends the daemon its pool again.

**Idempotent.** `devdrive.ps1 -Action ensure` finds the file in the root: if it exists it is attached and kept, never
recreated; it formats a disk only when the disk has **no partition** (an earlier run was cut off between creating and
formatting, with nothing on it to lose); a partition that holds anything is never touched. The helper tasks are
registered again (same names, `-Force`), the junctions are kept if they point at the right place and retargeted if they
do not, and `daemon.json` is rewritten with the same paths. Tested on a real Windows (GitHub's runner,
`.github/workflows/dev-drive.yml`, `scripts/worker/test/devdrive-e2e.ts`): three runs in a row give the same file
(creation time), the same letter, and the data written to the drive in between is still there.

**When the drive is missing at the daemon's start** (a reboot, a power cut, the attach failing): the host guard knows
the state from its start. New agents and editors in sandboxes are refused with the reason; its first look reports "Sandbox
drive not attached at startup" and starts `ffsb-helper-mount`; if that fails it tries again after 2, 5, 10 and 30
minutes and reports and stops after six (`machine_daemon restart` makes it try again). When the drive is back it starts
the editors that were up and tells the agents that were mid-turn to resume. That is BEAST's recovery path since w466,
unchanged; this install gets the same `hostGuard` settings (above). The root's `daemon\` folder is on the root's own
volume, so the daemon itself runs while the drive is gone.

**Compaction and trim.** The VHDX grows to the most the drive has held and **does not shrink by itself**; deleting a
sandbox frees space inside the drive, not on `D:`. Handing the free space back needs `Optimize-VHD`, which is in the
Hyper-V PowerShell module; `diskpart`'s `compact vdisk` finds free space through NTFS and reclaimed nothing on BEAST's ReFS
drive (245.6 GB before and after, measured 2026-09-24). The installer installs neither (adding a Windows feature is the
owner's decision) and registers `ffsb-helper-trim` (`Optimize-Volume -ReTrim`) and `ffsb-helper-compact` for a person to
start by hand: `compact` refuses while any `Unity.exe` has a project on the drive, retrims, detaches, runs `Optimize-VHD`
(Full with the disk attached read-only, else Pretrimmed), attaches again, and reports ok only if it reclaimed 1 GB. Without
the module it refuses before detaching anything and says how to get it. With block clones the drive holds one seed plus
what each sandbox changed, so the high-water mark is the thing to watch (`devdrive.json` and the file's size).

**Defender.** A Dev Drive is *trusted* when it is formatted, and Microsoft Defender then scans it in **performance mode**
(asynchronous) instead of real-time protection: Microsoft's default for a trusted Dev Drive, and the reason for the
format (sourced: Microsoft Learn, "Set up a Dev Drive on Windows 11", "What is Microsoft Defender performance mode?").
The installer changes nothing in Defender (a security setting is the owner's) and writes `fsutil devdrv query <letter>:`
into `mount.log`. The trust flag is stored in the registry of the PC that formatted the drive and survives a reboot; a VHDX
copied to another PC is not trusted there.

**Block cloning** needs Windows 11 24H2 or Windows Server 2025 (sourced: the same page, "Block Cloning Support"). The
installer reads whether the volume reports it (`fsutil fsinfo volumeinfo`: measured true on GitHub's Windows Server
runner, and the install says so for each PC). Without it, `daemon.json` keeps `robocopy` so the pool counts a full copy
honestly, and the install says why.

**The maximum size** defaults to **what the pool needs, capped by the root's volume's free space** (w1910, lothsahn: "The
maximum should be based on the number of slots and agents and workers selected and anything else that goes into that";
`scripts/worker/devdrive.ts` `DEV_DRIVE_SIZES`, `defaultMaxGB`); `-DevDriveMaxGB N` sets it. It is a ceiling, the file
takes what is written, but a dynamic VHDX never shrinks and the guard holds new agents back while the root's volume has less
free space than the file can still grow (below), so a ceiling the volume cannot hold stops the machine. The old default,
90 % of the volume's *size* up to 1 TB, gave LothLaptop (1 sandbox, 1 agent) a 1 TB drive on a D: with about 870 GB free:
the guard refused every agent ("D:/ 841 GB free (the Dev Drive's file can still grow 996 GB there)").

The need, in GB (GiB): what each part takes on disk on its own, counted once (w1947). A sandbox's LFS files are block
clones of the clone's LFS objects and its Library starts as a block clone of the seed, so those blocks count with the clone
and the seed. Measured on LothDesktop's V: on 2026-10-23 (6 sandboxes, 2 agents each) with cluster maps
(FSCTL_GET_RETRIEVAL_POINTERS: [sandbox-disk.md](sandbox-disk.md)'s `Phys.cs`): a sandbox's own part is its logical size
less what it shares with the clone and the seed. Dedup's sharing between sandboxes is not taken off: a new machine runs none.

| Part | GB | Rests on |
|---|---|---|
| Each sandbox | 30 | the largest of six, slot3 (the median one takes 18): its worktree less the LFS blocks it shares with the clone, 8.4 (Builds, Temp; 1 to 3 in the others); its Library less what it shares with the seed, 17.0 (build caches, BurstCache, reimports; 9 to 16 in the others); its two player folders, 4 (3.7 logical). All measured. The 11 GB over the median sandbox is the room for a sandbox's growth: what days of player builds and imports added. |
| Each agent (sandboxes x agents per sandbox) | 10 | `tmp\` held 109.2 (101.3 on disk) for 12 agent seats, unswept leftovers included: measured |
| Once per install | 38 | the clone 20: bare, no checkout (`git worktree list`, measured); pack 1.4 (`git count-objects`; 1.3 on LothLaptop's new clone) and master's LFS objects 8.9 (`git lfs ls-files -s`), measured, plus 10 for the LFS objects other branches bring (*a guess*, under LothDesktop's ~25 after 11 days, measured by difference: V: used less every other folder). The seed 9 (8.5 on disk), nightly-history 5 (4.6), tools and steam 2, ReFS's own 2 (an empty 80 GB V: on LothLaptop used 1.8): measured |
| Clean-up room | 20 | the pool's clean-up line, `disk_warn_gb` (lothsahn, w1910: "cleanup space should be 20G") |

w1910's first version summed logical sizes (`du -s`). That counted the seed's blocks again in every Library, the clone's
LFS blocks again in every worktree, and a 10 GB checkout the bare clone does not have: 44 GB a sandbox, 112 for one sandbox
with one agent.

One sandbox with one agent needs **98 GB**, the smallest safe drive; 6 sandboxes with 2 agents each, 358. The cap: the
root's volume keeps 30 GB free (the guard's 20 GB clean-up line plus its 10 GB hysteresis) or a tenth of its free space,
whichever is more (*a guess*). Under the need, the drive gets the cap and the install says so; under Windows' 50 GB
minimum (sourced: Microsoft Learn, "Set up a Dev Drive on Windows 11"), no drive is made and the install carries on
without one. A pool raised later needs a bigger drive: `-MoveToDevDrive` with `-DevDriveMaxGB` makes it again.

**Moving an existing install's sandboxes onto the drive** (`-Update -MoveToDevDrive`; LothDesktop's `D:\work\ffw`). It is
the only thing that touches sandboxes, so it runs only on request, and only when nothing works in them:

1. *Before anything changes* it refuses, naming them, if an agent is in a sandbox (the portal's view of the machine) or
   a Unity editor runs from one, if a sandbox is on a detached HEAD, if a sandbox on `master`, `main` or `develop` has
   uncommitted work (committing there is a person's decision), or if the untracked files are more than a save may carry
   (`SAVE_LIMITS`). It changes nothing in that case.
2. It stops the daemon (`Stop-FFDaemon` without `-Agents`: agents' hosts carry on, [above](#updating)) and **saves every sandbox's work**: the
   uncommitted changes and untracked files are committed on the sandbox's own branch and pushed, as FF Factory's release
   step does (`server/saveWork.ts`, w656). In an ssh session with no GitHub credential the push fails and says so; the
   commit is in the root's clone, which the new worktree uses, so nothing is lost, and the daemon pushes it on the next
   switch.
3. The seed is **moved**, not copied: `<root>\seed\Library` if there is one, else the Library of the sandbox changed last,
   with `robocopy /MOVE` (file by file, so `D:` frees as the drive fills and never holds both).
4. One sandbox at a time: its old Library, worktree and folder are removed; a worktree of the same branch is made on the
   drive and its Library **block-cloned from the seed**; the pool's record (`daemon\sandboxes.json`) and the sandbox's
   Claude conversation folder (`~/.claude/projects/<path slug>`) follow it. Six full Libraries are never copied.
5. The root's two folders become junctions; anything left in them that is not a pool sandbox is set aside whole as
   `sandboxes.before-dev-drive` (never deleted); `daemon.json` is written with the drive's paths; the daemon starts.

It is safe to run again after a stop: a sandbox already on the drive is skipped, one cut off between removal and creation
is created.
A folder that is cut off mid-removal (git dropped the worktree but something held the folder, so it stayed) is no
worktree git lists: an empty one is removed, one with leftovers is renamed `<name>.before-dev-drive` (never deleted), and the move
carries on. Before this fix (found on LothDesktop, w900) such a folder was read as "on a detached HEAD" and refused every resume. It runs in the background for an hour or more; `D:`'s free space before and after is what to report
(`Get-PSDrive D`). Tested on a real git repository with two worktrees, unsaved work, an unpushed commit, a cut-off run, and
a refused one (`scripts/devdrive.test.ts`); *not yet run on LothDesktop*.

**Restarting a Windows daemon by hand.** Use `machine_daemon restart`, never `schtasks /end` and `/run`. The task's action is a
headless console host that starts the supervisor (`run-daemon.ps1`), which starts node; ending the task ends the console host and
can leave the supervisor and the daemon running, and the next `/run` then starts a second pair (two daemons answering the portal
and the Unity slots mailbox, seen on LothDesktop after the w900 move). `Stop-FFDaemon` ends the whole tree by command line.
The installer starts the daemon only with `Start-ScheduledTask` after it has stopped the old one that way.

**Uninstall.** It attaches the drive first if it is not (the sandboxes' unpushed work is checked through the junction),
stops what runs from the root or the drive, takes the junctions away, removes the three SYSTEM tasks (only those whose
arguments name this root's VHDX), detaches the drive and deletes the file, then deletes the root. `check` lists the
tasks and the file. Nothing is deleted outside the root's folder; the drive's contents go with its file.

### The whole root on the Dev Drive (w1070)

**TL;DR:** On Windows with a Dev Drive the **whole worker root lives on the drive**, at `<letter>:\ffw` (`V:\ffw` on
LothDesktop), with no junctions. The folder the person gave (`D:\work\ffw`) is only the drive's **host folder**. FF Factory
reports and guards the drive's space as the machine's disk. lothsahn, 2026-10-12: "If using a dev drive, the entire folder
structure should be under V: Then we won't need the folder symlinks or anything"; "report space of the V: drive to ff factory
instead of the D: space for disk. And then cap the vdisk file at 275GB".

**What stays in the host folder, and why** (`scripts/worker/driveRoot.ts` `HOST_FILES`):

| File | Why it cannot be on the drive |
|---|---|
| `devdrive.vhdx` | the drive itself: a file cannot hold the volume it is the file of |
| `devdrive.json` | its letter, read by the boot mount (`ffsb-helper-mount`, SYSTEM, 30 s after boot) before the drive is attached |
| `daemon\` and `secrets\` | the daemon (its code, `daemon.json`, logs, `run-daemon.ps1`, the agent hosts' and the pool's records) and the machine credential. The daemon is what remounts the drive (its host guard runs `ffsb-helper-mount`), so it must not run from it: a dropped `V:` would take the daemon, its agent hosts and its logs with it, and nothing would remount it until the next logon. The `FFFactoryDaemon` task names `D:\work\ffw\daemon\run-daemon.ps1` directly, so it also starts at a logon that comes before the boot mount. BEAST keeps the same three in `C:\ffw-anchor` for the same reason ([worker-root.md](worker-root.md) 2.2); here `daemon.json` names them, with no junctions (`worker.ts` `layoutOf(root, anchor)`) |
| `moved.json` | where the root is: `worker.ts update --root D:\work\ffw` and `install.ps1 -Update -Root D:\work\ffw` follow it |

The helper scripts the boot mount runs stay in `%ProgramData%\ffsb-helpers`. A changed letter is followed: the boot mount
repoints `daemon.json`, the pool's record and the worktrees on the drive (`devdrive-lib.ps1` `Update-LetterDependents`).
**If V: drops while the machine runs**, the daemon on D: sees it (its host guard), stops the turns in sandboxes, remounts it
through `ffsb-helper-mount` (at once, then 2, 5, 10 and 30 minutes) and restarts the editors and resumes the agents, as on
BEAST ([self-recovery.md](self-recovery.md)).

**A new install** (`install.ps1`, `worker.ts install`) makes the drive first, in the folder given, and installs the root on it
(`install` step 0). **An existing w900 install** (sandboxes and seed on the drive behind junctions, the rest on D:) is made
again with **`install.ps1 -Reinstall -Root D:\work\ffw [-DevDriveMaxGB 275]`** (`worker.ts reinstall`; lothsahn: "Instead of
doing a move, can we just do a fresh reinstall on LothDesktop instead?"):

The old root's folder stays as the anchor: it keeps the new drive's VHDX, `devdrive.json`, the daemon and the credential, and
everything else goes to the drive (lothsahn: "The daemon and support files from the installer should go in d:\ffw. But all
the players, slots, everything else should go to V:"; "I meant keep the existing folder. Keep it at d:\work\ffw").
`-Anchor <folder>` puts those in another, new or empty folder instead, and the old root's folder is then removed.

1. It refuses, changing nothing, while the portal names an agent on the machine, a process uses the root or the drive (an
   editor, a build, a player, the nightly lab), or a sandbox holds a commit no remote has or an uncommitted file
   (`sandboxRisks`; commit each on its branch and push first). It needs an elevated session (an administrator's ssh). The new
   drive asks for the old one's letter by name: Windows keeps it reserved for the old volume.
2. It stops the daemon and first puts the clone, `nightly`, `tmp` and `scratch` aside in `<host>\.reinstall` (renames: a
   folder that will not move, because a process holds a file in it, stops it with all of them put back and nothing deleted;
   LothDesktop's first run on 2026-10-12 failed there after the old drive was gone, on find.exe and head.exe left by an
   agent's pipeline in `tmp`). Then it copies the Library seed (without BurstCache and BuildCache) off the old drive when it
   fits with 5 GB to spare (else the first new sandbox imports its Library, an hour or more), deletes the old drive and its
   tasks, and deletes everything else of the old install.
3. It installs as new with every setting and the credential of the old install (paths in the carried `daemon.json` settings
   rebased onto the new root): a new drive (`-DevDriveMaxGB`), the root on it with the daemon and the credential in the host
   folder, the clone seeded from the old one (its Git LFS
   objects too), `nightly`, `tmp`, `scratch` and the seed moved in file by file, a nightly lab task repointed if the machine
   still has one (the nightly run is portal-fired since w864, with `FF_NIGHTLY_ROOT` from the daemon's root), the sandboxes'
   Claude conversations renamed to the same sandbox names in the new root.

Lost by a reinstall: the sandboxes' worktrees (made again from their pushed branches when work is placed there), their
Libraries (block-cloned from the seed again), the players' copied builds, and the daemon's own state (its pool record, ended
agents' records).

**The disk FF Factory reports for the machine is the drive's.** The meters (`stats`) measure the volume of the clone, the
clean-up the volumes of the home folder, the clone and the sandboxes, the pool's guard the sandboxes' volume: all `V:` once
the root is there. The host guard still watches the host volume, because a dynamic VHDX that cannot grow takes the drive away
(BEAST, 2026-09-24), but it judges it by **whether the file can still grow to its maximum** (`hostGuard.devDriveVhdx`,
`devDriveMaxGB`; `server/hostHealth.ts` `roomLevel`), not by a number of GB: with a 275 GB cap and a file at 250 GB, D: at
39 GB free is fine; with the file at 200 GB it warns (no new editors or agents), and below `criticalFreeGB` it is critical.

Three fixes from LothLaptop's reset V: (w1918, 2026-10-23):

- **The maximum is the VHDX's own.** `devdrive.ps1 -Action status` reads it with `Get-DiskImage`, which needs no
  administrator rights (measured on LothDesktop: 300 GB). An update over the link records that number in `devdrive.json`,
  `root.json` and `daemon.json`'s `hostGuard.devDriveMaxGB` whenever it differs from the record. Before this, LothLaptop's
  guard judged an 80 GB drive by a stale 1024 GB record.
- **The disk line measures the clone's volume, else the sandboxes', else the root's.** When all three folders are gone, it
  measures the root's drive (`V:\`), never the home folder's (`machine/daemon.ts` `diskPath`). Before this, LothLaptop's line
  read "190 GB of 928 GB" (C:) while `V:\ffw\repo` was missing.
- **A machine's clean-up soft threshold fits its drive.** It is at most a quarter of the fullest volume's size, and never
  below the pool's 20 GB clean-up line (`server/cleanup.ts` `softFreeBytes`; the daemon's runner sets `fitSoftToVolume`).
  The portal's one `machines.cleanup.softFreeGB` (80) is meant for big disks: an empty 80 GB V: with 76.9 GB free read as
  low, and every 15 minutes the clean-up said it could not free enough. A drive the installer sizes (w1910's `defaultMaxGB`)
  keeps 20 GB free at its fullest, so a quarter of it is crossed only once the drive is mostly full. The portal host keeps
  the number set for it.

**If the drive comes back empty** (it was reset or made again by hand: LothLaptop, 2026-10-23, w1918), what is on D: is
intact, and the rest is made again by the update over the link and by the daemon: `machine_update` clones the repo again (the
installer clones whenever `<root>\repo` has no `HEAD`, `worker.ts` `cloneRepo`) and recreates the root's folders, and the
pool remakes each free sandbox whose folder is gone, once the sandbox root and the clone are there, on its branch (the clone's,
else origin's, else its base; `machine/sandboxes.ts` `remakeGone`, once per sandbox per daemon run). A folder with no `.git`
counts as gone: an agent placed there meanwhile makes its folder at its start, empty but for its own files (LothLaptop's slot1
had the w1915 worker in it). The worktree is then added beside it and its `.git` moved in (`git worktree repair`), so the
agent's files stay and it runs on in the checkout; a folder that holds a checkout's own files but no `.git` is left, as an
error. A remake a daemon restart cuts off (an update landing mid-checkout) is made again by the next daemon from the worktree it
had added (`Rec.remaking`); a plain create cut off still reads as an error. Work never pushed went with the drive. While the drive is not attached there is no sandbox root, so nothing is remade
then.

The maximum of an existing drive cannot be lowered in place (ReFS cannot shrink a volume, and `Optimize-VHD` needs the Hyper-V
tools; both measured on LothDesktop on 2026-10-12): an update keeps it and says so; a reinstall makes the drive again.

#### Growing the drive (w1918)

A larger maximum is the ops worker's `machine_update` with `dev_drive_max_gb` (the only control; lothsahn: "just build scoped
commands for the functionality needed ... But no way into machines"). The update writes it as `wantGB` in the host folder's
`devdrive.json` (`scripts/worker/worker.ts` `wantDevDriveGrow`), and the daemon's host guard grows the drive once no agent
(running, between turns or waiting) and no editor is in a sandbox (`machine/hostGuard.ts` `growIfIdle`). Until then the portal
hears "Dev Drive: grow pending" once, with who is there. While it grows, new agents and editors wait (`blockReason`), and the
guard does not look at the drive, which is detached on purpose.

The grow is the SYSTEM task `ffsb-helper-grow` (`scripts/privileged/ffsb-helper.ps1` `grow`), with fixed arguments like the
other helpers. It reads only `wantGB` from the state file and refuses a size that is smaller (ReFS cannot shrink), larger than
the volume that holds the VHDX, or wanted while a Unity editor uses the drive. It detaches the VHDX (`diskpart expand vdisk`
needs a detached disk: [expand vdisk](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/expand-vdisk)),
expands it, attaches it again at its letter (in a `finally`, so a failed expand still reattaches it), extends the ReFS volume
online (`Resize-Partition` to `Get-PartitionSupportedSize`'s maximum), and writes the new `maxGB` with the want cleared. The
next update records that maximum for the host guard's estimate.

A drive made before the task existed gets it the first time a larger size is asked: the update runs `devdrive.ps1 -Action
ensure` again, elevated, which registers the helpers with `grow` among them. That is one administrator prompt on the PC's
desktop, waited for 5 minutes (the daemon runs in the user's session, so its update can show one; an ssh session, in session 0,
cannot, and says so). Declined or unanswered, the want is still written, and the grow waits for the task.

Tested: `scripts/devdrive.test.ts` (the helper against faked disks: grown, never smaller, never past the host volume, never under
an editor, reattached after a failed expand), `server/machineGuard.test.ts` (waits while anything is in a sandbox, holds new work
while it grows, retries a failure after 30 minutes), and the real VHDX in `scripts/worker/test/devdrive-e2e.ts` (64 to 72 GB,
data kept, CI's `dev-drive.yml`).

### The portal's ssh (w568)

The portal updates an installed machine by having its installer run again there. A daemon from w1596 on takes the update,
a restart and the unload over its own link ([Updates over the daemon's link](#updates-over-the-daemons-link-w1596)), so a PC
that joins with a code installs with `-NoSsh`. ssh stays for an older daemon, for `machine_daemon start` and `stop`
(`start` is the only way back for a daemon that is not running), and for the ops worker's diagnosis (`server/machines.ts`
`controlDaemon`, `removeMachine`). An install without `--no-ssh` sets that ssh up itself, and nothing is done by hand on the
portal's host or in its VM:

1. **The portal's key onto this machine.** `GET /machine/ssh`, with this machine's own credential (never from an
   unauthenticated source), gives the line
   `from="<the portal's tailnet address>",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 ...`.
   It goes where this account's sshd reads keys:
   - on Windows, for a member of Administrators, `C:\ProgramData\ssh\administrators_authorized_keys`, which is
     Windows' default `Match Group administrators`. It is written in the install's one administrator step, with the
     firewall rules, and its ACL is Administrators and SYSTEM only;
   - otherwise `~/.ssh/authorized_keys`: the account and SYSTEM only on Windows, 0600 in a 0700 folder on a Mac.

   A line for the same key, pasted by hand earlier, is replaced in place. A re-run changes nothing. `root.json`
   records the line, and the uninstall removes exactly the lines for that key, unless it was there before the
   install.
2. **This machine's host keys into the portal.** The installer reads them from this machine's own sshd over loopback
   (`ssh-keyscan 127.0.0.1`: no network in between). It sends them to `POST /machine/ssh`, with this account's user
   name and the name the portal reaches it by: its tailnet MagicDNS name, or `--ssh-host` / `-SshHost`.
   - The portal keeps them on the machine's record, in its data, so a migration moves them and the backups keep
     them.
   - It writes them, pinned, into its own account's `~/.ssh/known_hosts2`, which ssh reads by default beside
     `known_hosts` (`server/machineSsh.ts`), and makes the record's ssh host `user@name`.
   - It tries its ssh at once. The installer prints `it reaches this machine as ...`, or why not.
   - A key is never accepted on first use.

No sshd running here (the Windows OpenSSH Server service, a Mac's Remote Login) is said, not fatal: the daemon works,
only those four actions cannot reach it. `--no-ssh` / `-NoSsh` skips both steps.

**Where each key lives, and why:**

| Key or pin | Where | Why |
|---|---|---|
| The portal's private key | the portal's VM only: `/srv/fff/home/.ssh/id_ed25519` (and the encrypted backups) | the portal opens the ssh connections |
| The portal's public key line | each machine, in the file above | that machine's sshd lets the portal in, from the portal's address only |
| The machines' host keys | the portal's data in the VM: each machine's record (`state.json`), written into `/srv/fff/home/.ssh/known_hosts2` at start and on each change | the portal checks it reaches the real machine; data, so a rebuilt VM keeps them |
| Machines from before the installer did this | `deploy/vm/guest/machines.ssh` in git, written into the VM's `~/.ssh/config` and `known_hosts` by `fff-machine-ssh` (guest install, `fffctl update`) or the host's `deploy/vm/host/machine-ssh.sh` | kept as the repair and check tool until every machine runs an installer from w568 on |
| The FFBox host (Loth2400) | nothing about the machines: only its own key to the VM's admin account (`/etc/fff-vm/ssh/`) | `machine-ssh.sh` ran there, but wrote into the VM over `fff-vm ssh` |

### Linux

A Linux PC (Ubuntu; biscuit, 2026-10-07) installs as a Mac does, with `install.sh`, into a root such as `~/ffw`. The
daemon runs as a **systemd user service** (`server/machineDeployLinux.ts`), as the user who installs it:

| | |
|---|---|
| The unit | `~/.config/systemd/user/com.fffactory.daemon.service`, enabled; `systemctl --user status com.fffactory.daemon`, log in `<root>/daemon/logs/daemon.log` |
| Supervisor | `Restart=always` (10 s), the Mac's KeepAlive; `requireSupervisor` checks it and `KillMode=process` |
| Agents through a restart | `KillMode=process`: a restart or an update stops the daemon only, so its agent hosts and Unity editors keep running (w605); systemd's default would kill everything in the unit's cgroup. A stop or an uninstall ends the agent hosts itself |
| Display | `WantedBy=graphical-session.target`: the daemon starts with the desktop session and gets its `DISPLAY`/`WAYLAND_DISPLAY`, which Unity needs. Turn on automatic login for a PC nobody sits at. The installer says so when the user's manager has no display yet |
| After a logout, over ssh | the installer runs `loginctl enable-linger`, so the user's manager (and the daemon) keeps running and `systemctl --user` works over ssh, which the portal's `machine_daemon` uses. If polkit refuses it, it says to run `sudo loginctl enable-linger <user>` |
| Sleep | the daemon holds a logind inhibitor (`systemd-inhibit --what=idle:sleep`) while agents run; for a PC that must never sleep, also `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` |

**What it needs first** (the installer checks each and changes nothing until all pass):

- **Node 22.6+ that runs TypeScript.** Ubuntu's own `nodejs` package is built without it (`ERR_NO_TYPESCRIPT`), whatever
  its version, so the installer skips it. Unpack the Linux x64 build from nodejs.org into `~/.local/node` (the installer
  and the probe look there) and put `~/.local/node/bin` on your PATH in `~/.bashrc`.
- **git 2.48+ and git-lfs**: `sudo apt install git git-lfs` (Ubuntu 26.04 has git 2.53; 24.04 has 2.43, so add
  `ppa:git-core/ppa` there first).
- **Claude Code**, logged in: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude` once.
- **Unity**: Unity Hub for Linux, with the project's editor version; editors are found in `~/Unity/Hub/Editor/<version>/Editor/Unity`
  and in any folder the Hub chose (its settings: `~/.config/unityhub`, lower case). The editor's log is `~/.config/unity3d/Editor.log`.
- **The portal's ssh**: `sudo apt install openssh-server`; the installer adds the portal's key to `~/.ssh/authorized_keys`
  and registers this PC's host keys with its tailnet name, as on a Mac. The tailnet policy must let `tag:fff-portal`
  reach it on 22 ([RUNBOOK](../deploy/vm/RUNBOOK.md) section 1, "Adding a machine").

**Differences from a Mac:** built players are `FinalFactory.x86_64` (Unity's Linux build; the guard and the slots know
them, and the slot config is `~/.config/finalfactory/player-slots.json`, as on a Mac); the game's save folder is
`~/.config/unity3d/Never Games/finalfactory`. There is no Unity dialog watch on Linux yet, and the daemon's removal of
old Unity editors leaves Linux editors alone. `add_machine` without `worker_install` refuses a Linux PC (the portal
never deploys one over ssh), and `migrate` refuses on Linux: there is no older layout to move.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <root>\daemon\src\scripts\worker\uninstall.ps1 -Root <root>
```

```bash
bash <root>/daemon/src/scripts/worker/uninstall.sh --root <root>
```

1. **Refuses, naming them**, while an agent there is mid-turn (the portal says) or a sandbox holds unpushed commits or
   uncommitted files (git says: `log HEAD --not --remotes`, `status`). `-Force` / `--force` discards them.
2. Asks to confirm (`-Yes` / `--yes` skips it).
3. The portal forgets the machine (`POST /machine/unenroll`: its agents stopped on purpose, its record and token gone).
   `-KeepRegistration` leaves the record (no portal, or a rolled-back migration whose record is the old daemon's).
4. Removes the task or LaunchAgent (waiting until launchd has let the daemon go), then stops whatever still runs from the
   root (sandbox editors, slot players, agents' shells; never Unity Hub, never itself).
5. Removes the firewall groups, the portal's ssh key line (unless it was there before; the admin file in the same
   administrator step) and the slot config (if it points into the root).
6. Deletes the root (`rmdir /s` and `rm -rf` never follow a junction or symlink), then runs the check below and lists
   what it left on purpose.

### Leaves-nothing-behind checklist

`worker.ts check --root <root> [--service <name>]` prints each line `gone` or `LEFT`; the uninstall runs it last and
exits 5 if anything is left. Windows: the root folder; the scheduled task; the two firewall groups (only those this
install made); any firewall rule whose program is under the root; the slot config pointing into the root; processes
whose command line names the root; HKCU Run entries naming the root. macOS: the root, the plist, the loaded
LaunchAgent, processes naming the root, the slot config.

The task's registry key (`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree\<task>`) cannot be read
without admin rights (measured: `reg query` fails non-elevated even for a task that exists), so it is not in the
automatic check; from an administrator PowerShell, `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree\FFFactoryDaemon"`
must fail after an uninstall.

## Migrating a machine from today's layout

```powershell
# a checkout of ff-factory to run it from (the install keeps its own copy in <root>\daemon\src)
git clone --depth 1 https://github.com/Final-Factory/ff-factory.git $env:TEMP\ff-factory
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\ff-factory\scripts\worker\migrate.ps1 -Root <root> [-From <old daemon folder>] [-OldSlots <old slot root>] [-Nightly <old nightly root>] -DryRun
```

- **`-DryRun`** lists what moves where, by rename (same volume: instant, undone by renaming back) or by copy (another
  volume: the space it needs), and what stays. It changes nothing.
- **Without it:**
  1. The root is installed beside the old layout (the same checks as an install), clone included, while the old daemon still runs.
  2. The daemon's state and each sandbox's Claude conversations are copied: `~/.claude/projects/<old folder name>` to the new one, so the agents resume there.
  3. Once no agent there is mid-turn (the portal says; it refuses and names them otherwise), the portal is told the daemon stops on purpose (`POST /machine/stopping`: its offline redeploy over ssh leaves the machine alone until a daemon says hello again; a portal without that route needs `machine_daemon stop` first), the old daemon stops (the migration checks nothing of it still runs), and each sandbox moves into the root (its editor must be stopped first). Its git is pointed at the root's clone: the branch and its commits fetched over, unpushed ones included; a new worktree entry made, with the old `.git` file kept as `.git.pre-ffw`; the index rebuilt and the staged part put back. Status and both diffs are compared before and after, and any difference rolls the whole migration back.
  4. The seed and the nightly lab follow (rename or copy), and the daemon state gets a second, verified pass (counts, sizes, SHA-256 of files under 1 MB).
  5. The daemon starts from the root with the machine's own credential and its old settings (host guard, protected paths, MCP server, limits), and the portal takes the root's folders from its hello.
- Progress for long copies is one line rewritten in place on a terminal (`\r` + ESC[K, no indent: w508's lesson), a
  plain line every 10 s otherwise. Copies are file by file, never tar, so a file written meanwhile cannot break them
  (w508); the second pass catches what changed.
- **`-Rollback`** (until cleanup): the root's task goes, each sandbox goes back with its old `.git` (and without the
  reimport folder the move armed), the seed and the nightly back, the old task or LaunchAgent restored from the copy
  saved before, and the portal's record gets the old folders back when the old daemon says hello.
- **`-Cleanup`** (after the new install has run well; it checks that the portal sees it online with its root): deletes
  the `.git.pre-ffw` files, the old daemon folder and the old slot root, and prunes the old clone's worktree entries
  for the moved sandboxes (the clone itself is untouched). **`-Legacy`** also archives `~/ff-worker` into
  `<root>/scratch/legacy/ff-worker` and removes the old ad-hoc lab tasks (`FF-Build-*`, `FF-LiveMP-*`, `ff-worker-leg`,
  `ff-detach-test`), each exported to `scratch/legacy/tasks/` first (decision 10).

The old slot root and the nightly lab are named on the command line, never guessed, so a run can never take a folder
that belongs to something else. The firewall step of the migration replaces the "Final Factory player slots" group
with the root's slots; after a rollback, `scripts/nightly/setup_player_slot_firewall.ps1 -Root <old slot root>`
(in the game repo) puts the old ones back.

## Per-machine commands (done; the old folders are gone, 2026-10-10)

Every machine's migration into its worker install folder has run, and the places the machines used before (the old
main clone, slot pool and nightly lab outside the install folder, on LothDesktop, the Macs and BEAST) are gone
(lothsahn, 2026-10-10: "those folders are all gone"). What replaced each lives inside the install folder: `repo/` (the install's own bare clone), `players/` (the slot pool) and `nightly/`
(the nightly lab), so on LothDesktop `D:\work\ffw\repo`, `D:\work\ffw\players` and `D:\work\ffw\nightly`. The game
repo's scripts take the slot root and the nightly root from `FF_PLAYER_SLOT_ROOT`, `FF_NIGHTLY_ROOT` or
`FF_WORKER_ROOT` (the daemon gives its agents all three) and refuse without them; they no longer guess a place.

A machine that still has its old folders (a new one, or one restored from a backup) migrates with the same tool; the
common steps are:

Common to all: tell the people with workers there; stop each sandbox editor (`unity stop`); wait until no agent there is
mid-turn; run the dry run, read it, then the same command without `-DryRun`. The firewall's UAC prompt appears on the
PC's desktop: someone at the PC answers it. Watch a day (`list_machines`, a worker started in a moved sandbox, an
editor start), then `-Cleanup`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\ff-factory\scripts\worker\migrate.ps1 -Root <install folder> -From <old daemon folder> -OldSlots <old slot root> -DryRun
```

```bash
git clone --depth 1 https://github.com/Final-Factory/ff-factory.git /tmp/ff-factory
bash /tmp/ff-factory/scripts/worker/migrate.sh --root ~/ffw --old-slots <old slot root> --max-sandboxes <n> --dry-run
```

- The git on a Mac must be 2.48 or newer (`brew upgrade git`; the M3 had 2.46). BEAST's git was 2.45 when measured:
  `winget upgrade --id Git.Git -e`, which is Ben's call since it is his PC.
- `~/.steamcmd-home` stays: last-resort uploads are a person's job.
- BEAST goes last: the portal gone from it first (w499, w510), and it turned into an ordinary machine
  (`convert_machine beast to: "ssh"`). Its slot config must not point at a removable stick: `D:` there is a 32 GB
  FAT32 stick labelled "BIOS" (`player_slots.py fixed-root` says so).
- The nightly lab does not follow the root by itself on a machine that still has a scheduled task naming a root; since
  w864 the portal fires the night, so there is no task to re-point (docs/intake.md, "Nightly e2e regressions").

An open choice for BEAST: with the root on `F:` (the Dev Drive, so sandboxes, seed and slots keep block clones and hard
links), the daemon's own code is on `F:` too. Since w466 the daemon is what remounts `F:` when Windows drops it, and
its supervisor could not restart it while `F:` is gone (worker-root.md 2.2). The alternative is the root on `C:`
(259 GB free, NVMe), giving up the Dev Drive's block clones for new sandboxes. The recommendation is `F:`, keeping the
`ffsb-helper-mount` SYSTEM task at boot as the fallback that brings `F:` back after a reboot. *(Guess: a drop without a
reboot then needs a person; it happened once, 2026-09-24.)*

Then `-Cleanup -Legacy` (`~/ff-worker` and the four old tasks; decision 10). `F:\ffsb\_scratch` (141 GB) is reviewed
by hand first. `F:\ffsb\_review` is the portal's. `C:\ffsb\_base` is Ben's: cleanup only prunes its worktree entries
for the moved sandboxes.

## Built players run only from the slots

- `scripts/nightly/player_slots.py` (the pool, w350) is the one way a player starts: `launch`, `FF_LAUNCH` in bash,
  `slot_path`/`acquire_or_fallback` in Python. The daemon gives agents `FF_PLAYER_SLOT_ROOT=<root>/players`; scripts
  outside it read the slot config the install writes (`layout: sandbox-pairs`, `count`: the sandbox count).
- **Each sandbox has its own pair** (lothsahn, w576): `player_slots.py` finds its sandbox (`FF_UNITY_HOLDER`, else the
  working folder under `<root>/sandboxes/slotK`) and uses only `slotK-0` and `slotK-1`. A build already in one is
  reused; a second, different build takes the other; `--peer 0|1` (or `FF_PLAYER_PEER`) picks one. So a 2-peer run of
  one build shares `slotK-0` unless its client passes `--peer 1`, and a cross-build desync check (host on one build,
  client on another) gets one folder each. A process outside every sandbox has no player slot (the nightly lab's
  `slotnightly-0` and `-1` are gone since w1099; the installer removes them); the sandbox is `FF_SANDBOX_ID`, else
  `FF_UNITY_HOLDER`, else the working folder.
- The workers' guard refuses a shell command that starts `finalfactory.exe` or a `finalfactory.app` outside a slot
  (`server/guard.ts` `checkPlayerLaunch`), naming the slot launcher to use; in sandbox slotK it also refuses another
  sandbox's pair.
- **Changing the sandbox count:** the ops worker runs the installer again with `--max-sandboxes N` (`ops_worker machine_update`, never a person; it refuses N below the sandboxes
  there). It adds or removes pairs (a folder a player still runs from stays, said), replaces the firewall group, writes
  the slot config, and the portal takes N from the daemon's next hello. `add_machine` on a root install changes its
  other limits in place and refuses `max_sandboxes`.
- Game repo (PR #1116): `lab.py`'s remote Windows peer refuses instead of starting from its build folder, and the mode2
  CI runner on BEAST turns the pool on (decision 8); ff-agents: the determinism-audit skill and its recipe launch through
  the slots.
- The Unity editor needs no slot: a firewall rule names the program path, and the editor's path is fixed per Unity
  version (BEAST has one rule set for `C:\Program Files\Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe` after months of
  editors in many sandbox folders, measured in w511). The install adds rules for every editor the Hub lists, in their
  own group.
- `NotifyOnListen` is never changed (decision 7).

## Testing

Everything here runs against a throwaway portal, never the live one: `node scripts/worker/test/portal.ts <scratch>
<port>` starts the real server in portal-only mode with a scratch data folder, one machine record and its credential
in `<scratch>/credential.txt`, and a driver on port+1 (`POST /sandbox {name}`, `GET /machine`).
`scripts/worker/test/oldLayout.ts` builds today's layout in scratch for a migration test: a daemon running from
its own folder under its own task name, a clone, and a sandbox holding an unpushed commit plus staged, unstaged and
untracked work.

Test installs use their own service name (`-Service FFWorkerTest-…` / `--service com.fffactory.…`), their own Unity slots
mailbox (`-UnitySlotsDir`), `-NoCleanup` (the test daemon must not clean a computer that holds other work: since w1596 it also
runs no leftover reaper, which reads every process on the computer and the shared player slots, starts no tray, and on a Mac
leaves the computer's player-slots pointer alone; daemon.json `leftovers: false`, carried by its updates) and, where the computer's own git is older than 2.48,
`-AbsoluteWorktrees`. Once git makes a worktree with relative paths it marks the clone
`extensions.relativeWorktrees`, and every older git refuses to open it (measured: git 2.45.1 says "unknown repository
extension"). So on a real install every git the daemon and its tools use must be 2.48+, which is why the installer
requires it.

What was run (2026-10-06):
- **BEAST** (Windows 11), against the throwaway portal on port 8799:
  - install, refused with git 2.45 and changing nothing; re-run, a safe re-run;
  - a sandbox created through the portal as a worktree of the root's clone;
  - uninstall refused with an unpushed commit and an uncommitted file named; after pushing, a clean uninstall with every check line `gone` and the portal's record removed;
  - migration of the old-layout fixture: dry run, migrate, rollback (old daemon and folders back, the portal's record restored), migrate again, cleanup (old daemon folder deleted, the old clone's worktree entry pruned), then uninstall with `-Force`. Nothing was left.
- **M5** (macOS 26.4), through an ssh tunnel to the same portal: install (relative worktree paths with git 2.50), a sandbox, uninstall refused for an uncommitted file, then a clean uninstall with every check line `gone`.
- Not run: the elevated firewall step. This agent cannot answer a UAC prompt; the script parses, and its rules match the game repo's `setup_player_slot_firewall.ps1`. The first real install shows it.
- Not run: a migration of a real machine, and a fresh install of a new machine against the live portal. That needs w512's enrollment for its credential.
- Unit tests: `scripts/worker-install.test.ts` and `server/playerLaunch.test.ts`, in CI.

## Decisions it follows (lothsahn, 2026-10-06)

1. The root is any folder; nothing assumes a drive.
2. The daemon runs as the user who installs it.
3. No HOME override: tools keep their files in the home folder, listed above.
4. GitHub access through a token the portal hands out (w512), else the user's own gh login.
5. The game's save and data folder stays where the game puts it.
6. Slot names: `slotK-0` and `slotK-1` for sandbox slotK, K = 1..N, N the sandbox count (w576, replacing
   `slot0..slotN-1`).
7. Never `NotifyOnListen False`; the installer makes the slot rules once.
8. BEAST's CI runner uses the slots.
9. Sandboxes are renamed in place.
10. `~/ff-worker` and the old tasks archived then removed, at migration time with his go; `_scratch` reviewed first.
11. A fresh clone (no `--reference`).
12. git 2.48+ required; the installer offers to install it.
