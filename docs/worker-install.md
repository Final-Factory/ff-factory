# Worker install: one root folder, one command to install, remove or migrate (w513)

**TL;DR:** A worker machine's daemon and everything its agents use live under one root folder, in any folder you pick.
`scripts/worker/install.ps1` (Windows) or `install.sh` (macOS and Linux) installs it, `uninstall` removes it and proves nothing is
left, and `migrate` moves a machine from today's scattered layout into a root (copy-first and verified, with rollback).
Built players run only from fixed player folders: each sandbox slotK owns `<root>/players/slotK-0/player/` (peer 0,
the host) and `slotK-1/player/` (peer 1, the client), the nightly lab (no sandbox) owns `slotnightly-0` and
`slotnightly-1`, and Windows Firewall gets one inbound rule per folder (w576).
`--max-sandboxes N` makes the sandboxes' count and these N pairs together. The design and the inventory it rests on: [worker-root.md](worker-root.md). lothsahn's
decisions of 2026-10-06 override it where they differ (listed at the end).

## The layout

```text
<root>/                 any folder (lothsahn, decision 1): D:\work\ffw, F:\ffw, ~/ffw ...
  root.json             the install's id, layout version, machine, service name, and every thing outside the root it made
  daemon/               app/ (the daemon's code), src/ (the ff-factory checkout it was installed from), daemon.json (no
                        token), run-daemon.ps1, logs/, agents/ (standing agents), unity-mcp/, state files
  secrets/              machine-token: the machine's credential, owner-only (Windows ACL: the user and SYSTEM; macOS 0700)
  repo/                 the install's own bare clone of the game repo; every sandbox is a worktree of it
  sandboxes/<name>/     the sandboxes
  seed/Library/         the Library seed new sandboxes are warmed from
  players/slotK-0, -1/  each sandbox slotK's two player folders, K = 1..N, and slotnightly-0, -1 for the nightly lab
                        (scripts/nightly/player_slots.py, layout sandbox-pairs, w576): FF_PLAYER_SLOT_ROOT for agents
  nightly/              the nightly lab: FF_NIGHTLY_ROOT
  scratch/              long-lived scratch; scratch/legacy/ holds what a migration archived
  tmp/                  agents' TMP, TEMP and TMPDIR (one ffa-<session> folder each)
  voice/                only with --voice-whisper (w615): the GPU Whisper for the portal's mic, uv's Python, its venv,
                        the model, setup.log (docs/voice.md "Whisper on a worker's GPU"); the daemon installs and updates it
  migration.json        only after a migration: its journal, read by rollback and cleanup
```

The daemon reads `root` from its `daemon.json` and derives the rest (`machine/daemon.ts` `withRootDefaults`, `rootEnv`).
Its agents get `FF_WORKER_ROOT`, `FF_PLAYER_SLOT_ROOT` and `FF_NIGHTLY_ROOT`. The credential is read from
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
| Firewall rules | group "Final Factory player slots" (per slot exe path: in and out, TCP and UDP, every profile) and group "Final Factory Unity editors" (each Unity editor the Hub has) | none |
| The slot config for scripts outside the daemon | `%ProgramData%\FinalFactory\player-slots.json` | `~/.config/finalfactory/player-slots.json` |
| The Unity slots mailbox (`~/.ff-factory/unity-slots`, its standard place: no pointer is written, so the daemon, its agents and the nightly harness all use the same one, w469) | `%USERPROFILE%\.ff-factory\unity-slots` | `~/.ff-factory/unity-slots` |
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

### Updating

**A portal update does not need a worker update** (w605). The portal and the daemon are versioned by their protocol
(`server/machineProtocol.ts`), not by commit: a daemon from another commit whose protocol the portal drives (7 and up
today) shows "update available" and keeps taking, starting and resuming agents ([machines.md](machines.md),
"Versions"). The portal says once, in a `[machines]` line, that an update is available. Only a protocol out of range
(outdated) stops new agents there until the install is updated.

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


### The portal's ssh (w568)

The portal updates an installed machine by having its installer run again there, never over ssh. It still uses ssh
for `machine_daemon start`, `stop` and `restart`, and for `remove_machine`'s unload (`server/machines.ts`
`controlDaemon`, `removeMachine`). `start` is the only way back for a daemon that is not running. So the installer
sets that ssh up itself, and nothing is done by hand on the portal's host or in its VM:

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
  and wherever the Hub lists them (`~/.config/UnityHub`). The editor's log is `~/.config/unity3d/Editor.log`.
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

## Per-machine commands (each needs lothsahn's go; in this order)

Common to all: tell the people with workers there; stop each sandbox editor (`unity stop`); wait until no agent there is
mid-turn; run the dry run, read it, then the same command without `-DryRun`. The firewall's UAC prompt appears on the
PC's desktop: someone at the PC answers it. Watch a day (`list_machines`, a worker started in a moved sandbox, an
editor start), then `-Cleanup`.

**1. LothDesktop** (measured 2026-10-06 over ssh: git 2.50, node 22.17, NTFS `D:` with 81 GB free, six sandboxes in
`D:\work\ffsb`, daemon folder `D:\work\.ff-factory`, clone `D:\work\FFFRepo`, slots `D:\work\ff-players`, nightly
`D:\work\ff-nightly`; no Library seed). Everything is on `D:`, so every move is a rename.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\ff-factory\scripts\worker\migrate.ps1 -Root D:\work\ffw -From D:\work\.ff-factory -OldSlots D:\work\ff-players -DryRun
```

Leave `-Nightly` out unless the nightly lab's own scheduled task is re-pointed in the same sitting; otherwise it keeps
running from `D:\work\ff-nightly`. After cleanup, `D:\work\FFFRepo` is lothsahn's alone.

**The nightly lab does not follow the root by itself** (w577): its task `ff-nightly-e2e` names its root on its command
line. After the migration (and after any install on a machine that has the task), re-point it from a game checkout,
which makes the nightly checkout in the root and replaces the task:

```bash
FF_NIGHTLY_ROOT=/d/work/ffw/nightly bash scripts/nightly/install_schedule.sh
schtasks //query //tn ff-nightly-e2e //xml | grep Arguments   # names /d/work/ffw/nightly
```

The install and the migration print a WARNING naming the task while it runs from anywhere else. LothDesktop was
re-pointed this way on 2026-10-06 (w577), after its old `D:\work\ff-nightly` had been deleted.

**2. The M3** (measured: git **2.46**, below 2.48; **49 GB** free; nightly lab `~/nevergames/ff-nightly` run by its own
LaunchAgent; slots `~/nevergames/ff-players`; no sandboxes today). First `brew upgrade git`. With 49 GB, one sandbox at
most.

```bash
git clone --depth 1 https://github.com/Final-Factory/ff-factory.git /tmp/ff-factory
bash /tmp/ff-factory/scripts/worker/migrate.sh --root ~/ffw --old-slots ~/nevergames/ff-players --max-sandboxes 1 --dry-run
```

The nightly lab moves only with `--nightly ~/nevergames/ff-nightly` and its LaunchAgent re-installed with
`FF_NIGHTLY_ROOT=~/ffw/nightly` (`scripts/nightly/install_schedule.sh`).

**3. The M5** (measured: git 2.50, 265 GB free; slots `~/nevergames/ff-players`; no sandboxes today):

```bash
bash /tmp/ff-factory/scripts/worker/migrate.sh --root ~/ffw --old-slots ~/nevergames/ff-players --max-sandboxes 3 --dry-run
```

`~/.steamcmd-home` stays: last-resort uploads are a person's job.

**4. BEAST**, last. It also needs:
- the portal gone from BEAST first (w499, w510), and BEAST turned into an ordinary machine (`convert_machine beast to: "ssh"`);
- git upgraded from 2.45 (`winget upgrade --id Git.Git -e`), which is Ben's call: it is his PC.

Measured on BEAST:
- its slot config `%ProgramData%\FinalFactory\player-slots.json` points at `D:\work\ff-players`, on the 32 GB removable FAT32 stick labelled "BIOS". `player_slots.py`'s `default_root()` tries `D:\work` first, and that folder exists there;
- its nightly root is `D:\work\ff-nightly` on the same stick;
- `F:\ff-players` holds an older pool (13 GB).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\ff-factory\scripts\worker\migrate.ps1 -Root F:\ffw -OldSlots D:\work\ff-players -DryRun
```

An open choice for BEAST: with the root on `F:` (the Dev Drive, so sandboxes, seed and slots keep block clones and hard
links), the daemon's own code is on `F:` too. Since w466 the daemon is what remounts `F:` when Windows drops it, and
its supervisor could not restart it while `F:` is gone (worker-root.md 2.2). The alternative is the root on `C:`
(259 GB free, NVMe), giving up the Dev Drive's block clones for new sandboxes. The recommendation is `F:`, keeping the
`ffsb-helper-mount` SYSTEM task at boot as the fallback that brings `F:` back after a reboot. *(Guess: a drop without a
reboot then needs a person; it happened once, 2026-09-24.)*

Then `-Cleanup -Legacy` (`~/ff-worker` and the four old tasks; decision 10). `F:\ff-players` and `F:\ffsb\_scratch`
(141 GB) are reviewed by hand first. `F:\ffsb\_review` is the portal's. `C:\ffsb\_base` is Ben's: cleanup only prunes
its worktree entries for the moved sandboxes. The M3's nightly watchdog task (`ff-nightly-e2e-watchdog`,
`F:\ffsb\_nightly-e2e`) stays as it is.

## Built players run only from the slots

- `scripts/nightly/player_slots.py` (the pool, w350) is the one way a player starts: `launch`, `FF_LAUNCH` in bash,
  `slot_path`/`acquire_or_fallback` in Python. The daemon gives agents `FF_PLAYER_SLOT_ROOT=<root>/players`; scripts
  outside it read the slot config the install writes (`layout: sandbox-pairs`, `count`: the sandbox count).
- **Each sandbox has its own pair** (lothsahn, w576): `player_slots.py` finds its sandbox (`FF_UNITY_HOLDER`, else the
  working folder under `<root>/sandboxes/slotK`) and uses only `slotK-0` and `slotK-1`. A build already in one is
  reused; a second, different build takes the other; `--peer 0|1` (or `FF_PLAYER_PEER`) picks one. So a 2-peer run of
  one build shares `slotK-0` unless its client passes `--peer 1`, and a cross-build desync check (host on one build,
  client on another) gets one folder each. A process outside every sandbox (the nightly lab's scheduled task, which
  has no FF_* variables) uses `slotnightly-0` and `slotnightly-1`; the sandbox is `FF_SANDBOX_ID`, else
  `FF_UNITY_HOLDER`, else the working folder.
- The workers' guard refuses a shell command that starts `finalfactory.exe` or a `finalfactory.app` outside a slot
  (`server/guard.ts` `checkPlayerLaunch`), naming the slot launcher to use; in sandbox slotK it also refuses another
  sandbox's pair.
- **Changing the sandbox count:** run the installer again with `--max-sandboxes N` (it refuses N below the sandboxes
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
mailbox (`-UnitySlotsDir`), `-NoCleanup` (the test daemon must not clean a computer that holds other work) and, where the computer's own git is older than 2.48,
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
