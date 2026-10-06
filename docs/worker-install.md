# Worker install: one root folder, one command to install, remove or migrate (w513)

**TL;DR:** A worker machine's daemon and everything its agents use live under one root folder, in any folder you pick.
`scripts/worker/install.ps1` (Windows) or `install.sh` (macOS) installs it, `uninstall` removes it and proves nothing is
left, and `migrate` moves a machine from today's scattered layout into a root (copy-first and verified, with rollback).
Built players run only from the fixed slot paths `<root>/players/slotK/player/`, and Windows Firewall gets one rule
set per slot, made once. The design and the inventory it rests on: [worker-root.md](worker-root.md). lothsahn's
decisions of 2026-10-06 override it where they differ (listed at the end).

## The layout

```text
<root>/                 any folder (lothsahn, decision 1): D:\work\ffw, F:\ffw, ~/ffw ...
  root.json             the install's id, layout version, machine, service name, and every thing outside the root it made
  daemon/               app/ (the daemon's code), src/ (the ff-factory checkout it was installed from), daemon.json (no
                        token), run-daemon.ps1, logs/, agents/ (standing agents), unity-slots/, unity-mcp/, state files
  secrets/              machine-token: the machine's credential, owner-only (Windows ACL: the user and SYSTEM; macOS 0700)
  repo/                 the install's own bare clone of the game repo; every sandbox is a worktree of it
  sandboxes/<name>/     the sandboxes
  seed/Library/         the Library seed new sandboxes are warmed from
  players/slot0..7/     the player slot pool (scripts/nightly/player_slots.py): FF_PLAYER_SLOT_ROOT for agents and scripts
  nightly/              the nightly lab: FF_NIGHTLY_ROOT
  scratch/              long-lived scratch; scratch/legacy/ holds what a migration archived
  tmp/                  agents' TMP, TEMP and TMPDIR (one ffa-<session> folder each)
  migration.json        only after a migration: its journal, read by rollback and cleanup
```

The daemon reads `root` from its `daemon.json` and derives the rest (`machine/daemon.ts` `withRootDefaults`, `rootEnv`).
Its agents get `FF_WORKER_ROOT`, `FF_PLAYER_SLOT_ROOT` and `FF_NIGHTLY_ROOT`. The credential is read from
`secrets/machine-token` at start (`readToken`); a portal redeploy over ssh that writes a fresh token into `daemon.json`
still works, since that one wins.

**In the home folder, on purpose** (lothsahn, decision 3: tool dependencies may use it; nothing overrides HOME):
Claude Code's `~/.claude` (settings, plugins, and the agents' conversations under `~/.claude/projects/<folder name>`),
`~/.claude.json`, git's `~/.gitconfig` and its credential helper, gh's login, `~/.ssh`, `~/.unity-mcp` (written by the
MCP-for-Unity editor plugin), Unity's caches, logs and licence (`%LOCALAPPDATA%\Unity`, `%USERPROFILE%\AppData\LocalLow\Unity`,
`~/Library/Logs/Unity`), and the game's save and data folder (`...\LocalLow\Never Games\finalfactory`,
`~/Library/Application Support/Never Games/finalfactory`; decision 5). The uninstall leaves these.

**Outside the root, made by the install and removed by the uninstall** (listed in `root.json` `outside`):

| What | Windows | macOS |
|---|---|---|
| The service | scheduled task `FFFactoryDaemon` (at logon, the user's interactive session, not elevated) | LaunchAgent `com.fffactory.daemon` (`~/Library/LaunchAgents`) |
| Firewall rules | group "Final Factory player slots" (per slot exe path: in and out, TCP and UDP, every profile) and group "Final Factory Unity editors" (each Unity editor the Hub has) | none |
| The slot config for scripts outside the daemon | `%ProgramData%\FinalFactory\player-slots.json` | `~/.config/finalfactory/player-slots.json` |
| The portal's record | removed through `POST /machine/unenroll` | the same |

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
relative worktree paths); the daemon's code from the installer's checkout, `npm ci`; `daemon.json`; the task or
LaunchAgent, started; the firewall rules for `players\slot0..7\player\finalfactory.exe` and the Unity editors, plus the
slot config (one UAC prompt); and it waits until the portal sees the machine online with its root. Re-running it
updates the code and keeps everything else (that is also how a root install is **updated**: the portal never
redeploys one over ssh, it says "re-run its installer" when the daemon is outdated).

**The credential** is the machine's `/machine` token, `ffm_<machine id>_<secret>`: the only token on the box (w512). The
portal makes the machine's record and the credential (w512's enrollment, worker d91ca8cf); the installer only stores
it. A migration needs none: it keeps the token the old daemon already has.

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
5. Removes the firewall groups and the slot config (if it points into the root).
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
  3. Once no agent there is mid-turn (the portal says; it refuses and names them otherwise), the old daemon stops and each sandbox moves into the root (its editor must be stopped first). Its git is pointed at the root's clone: the branch and its commits fetched over, unpushed ones included; a new worktree entry made, with the old `.git` file kept as `.git.pre-ffw`; the index rebuilt and the staged part put back. Status and both diffs are compared before and after, and any difference rolls the whole migration back.
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

Leave `-Nightly` out unless the nightly lab's own scheduled task is re-pointed in the same sitting (re-run
`scripts/nightly/install_schedule.sh` with `FF_NIGHTLY_ROOT=D:\work\ffw\nightly`); otherwise it keeps running from
`D:\work\ff-nightly`. After cleanup, `D:\work\FFFRepo` is lothsahn's alone.

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
  outside it read the slot config the install writes.
- The workers' guard refuses a shell command that starts `finalfactory.exe` or a `finalfactory.app` outside
  `.../slotK/player/` (`server/guard.ts` `checkPlayerLaunch`), naming the slot launcher to use.
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

Test installs use their own service name (`-Service FFWorkerTest-…` / `--service com.fffactory.…`), `-NoCleanup` (the
test daemon must not clean a computer that holds other work) and, where the computer's own git is older than 2.48,
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
6. Slot names as today: `slot0..slotN-1/player/`.
7. Never `NotifyOnListen False`; the installer makes the slot rules once.
8. BEAST's CI runner uses the slots.
9. Sandboxes are renamed in place.
10. `~/ff-worker` and the old tasks archived then removed, at migration time with his go; `_scratch` reviewed first.
11. A fresh clone (no `--reference`).
12. git 2.48+ required; the installer offers to install it.
