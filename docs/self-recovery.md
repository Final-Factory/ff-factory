# Self-recovery: disk space, the sandbox drive, memory, crash-safe data

The point of FF Factory is that nobody has to be at the host. So the failures that stop everything
must heal by themselves. On 2026-09-24 one did not. C: filled up: leaked headless browsers held
24 GB of RAM, the pagefile tried to grow by 37-39 GB, and a big editor allocation failed. The
dynamically expanding Dev Drive VHDX then could not grow ("Write operation failure with status
0xC000007F", STATUS_DISK_FULL). Windows surprise-removed F:, every Unity editor on it died, and
reattaching it needed an administrator.

Three parts now handle that class of failure.

## 1. Privileged helpers (installed once, as administrator)

`scripts/install-privileged-helpers.ps1` registers one on-demand scheduled task per action. Each
runs `%ProgramData%\ffsb-helpers\ffsb-helper.ps1` as SYSTEM with arguments fixed at install time.
That folder is writable only by SYSTEM and Administrators. The app's user gets read + run rights on
those tasks (task DACL `GRGX`), so it can start an action but cannot change what it runs or pass
arguments. There is no arbitrary command path.

| Task | Does |
|---|---|
| `ffsb-helper-mount` | attach the VHDX if it is not attached, bring its disk online, give its data partition the drive letter, wait for it. Also runs **at every boot** (30 s after startup). Each step is retried three times; when the storage cmdlets are refused ("Access denied" from the storage CIM provider, seen at boot on 2026-09-24), it falls back to `diskpart` to attach the VHDX and assign the letter. Every attempt goes to `results\mount.log` |
| `ffsb-helper-trim` | `Optimize-Volume -ReTrim` on the Dev Drive: free space inside the volume is handed back to the VHDX |
| `ffsb-helper-compact` | refuses while any `Unity.exe` has a project on the drive; retrim, detach, `Optimize-VHD` (Full with the disk attached read-only, else Pretrimmed), reattach; reports ok only if it reclaimed at least 1 GB. Without the Hyper-V module and with a ReFS volume it refuses up front, without detaching (see the VHDX policy) |
| `ffsb-helper-detach` | detach the VHDX, for the recovery self-test; refuses while any `Unity.exe` uses the drive |
| `ffsb-helper-reboot` | a reboot in 2 minutes (`shutdown /a` cancels it). Refused unless automatic logon is set up, and at most once per 6 hours |
| `ffsb-helper-pagefile` | only with `-PagefileGB N`: a fixed pagefile of N GB, from the next boot |

**A worker install's Dev Drive (w900)** uses the same three tasks (`mount`, `trim`, `compact`; the others are not
registered), made by `scripts/install-privileged-helpers.ps1 -Flex …` from the installer. `-Flex` makes the letter a
preference: if another claim has taken it, the next free letter from V: down is used and what stored the old one is
repointed ([worker-install.md](worker-install.md#the-dev-drive-w900)). The helper's attach code now lives in
`scripts/privileged/devdrive-lib.ps1` (copied beside it), unchanged for BEAST, which has no `-Flex`.

Each writes `%ProgramData%\ffsb-helpers\results\<action>.json` (`ok`, `at`, `detail`). The app
starts one with `schtasks /run /tn ffsb-helper-<action>` and waits for that file
(`server/privileged.ts`). Since w510 the only caller is BEAST's daemon's guard, and it starts `ffsb-helper-mount`
only (`machine/hostGuard.ts`): the portal's `host_recovery` actions that started the others are gone. `trim`,
`compact`, `detach`, `reboot` and `pagefile` stay installed, for a person to start by hand at BEAST
(`schtasks /run /tn ffsb-helper-compact`).

`-User` defaults to the account of the app's `ffsb-server` logon task (else the account running the
installer). It must resolve to a SID before anything is registered; over OpenSSH `USERDOMAIN` is
`WORKGROUP`, so the installer never builds the name from it. Re-run the installer after pulling a new
version: it copies the current helper script and registers new actions (it is idempotent).

```powershell
# once, as administrator (e.g. over SSH with an elevated account):
.\scripts\install-privileged-helpers.ps1 -Vhdx C:\ffsb-devdrive.vhdx -Letter F
.\scripts\install-privileged-helpers.ps1 -PagefileGB 48      # also offer a fixed pagefile
.\scripts\install-privileged-helpers.ps1 -Uninstall
```

**After a reboot or a power cut.** A VHDX attachment does not survive either. `ffsb-helper-mount` attaches it at boot, and BEAST's daemon's guard starts it again when the drive is missing and retries (below). The supervisor (`scripts/supervise.ps1`) no longer waits for the drive before it starts the portal (w510: the portal holds no sandboxes); after an unclean stop the portal waits up to 15 minutes for it before it resumes BEAST's agents ([restart.md](restart.md)). The boot trigger is registered by `install-privileged-helpers.ps1`, so re-run it once (as administrator) after updating to get it.

**Reboot and automatic logon.** Unity editors need the interactive desktop (GPU), and the app
starts at logon (the `ffsb-server` task). After a reboot without automatic logon nothing comes back
until someone logs in, so the helper refuses. To allow reboots as a last resort, set up automatic
logon with Sysinternals Autologon, which stores the password as an LSA secret, not in plain text.
Prefer to leave it off and fix what makes reboots necessary.

## 2. The host guard (`server/hostHealth.ts`)

Two guards run these decisions (`HostHealthMonitor`). **The portal's** has no sandbox drive (w510: it runs only the
orchestrators and the dispatcher; `HostDeps.watchDrive` is false, `server/index.ts`): it measures the volume of its
data folder (`dataDir`: state, transcripts, attachments) and each of `hostDiskPaths`, reports, and runs the clean-up of
this computer. It gates nothing (`SessionManager.startGate` is gone) and never blocks on or reattaches a drive.
`host_recovery` takes only `cleanup`. **A machine's daemon's** (`machine/hostGuard.ts`, below) owns that machine's
sandbox drive. Before w510 the portal's guard watched the sandbox drive too, and `host_recovery` also had `remount`,
`trim`, `compact`, `selftest` and `reboot`.

Every `hostGuard.pollSeconds` (30) it measures the volumes above (the sandbox root's, on a daemon;
`hostDiskPaths`, where you put `"C:/"` when the Dev Drive's VHDX lives on C:), free RAM, and, on a daemon, whether the
sandbox root exists.

**Disk levels**, with `hysteresisGB` (10) before a level clears:

| Level | When (any watched volume) | What happens |
|---|---|---|
| warn | below `warnFreeGB` (80) | a `[host]` message to the orchestrator and a push (kind "Host health"); on a machine's daemon, new sandbox agents and editors there are also refused with the reason |
| critical | below `criticalFreeGB` (40) | also: a clean-up pass with every rule runs (at most every 10 minutes); the daemon's guard also stops sandbox editors nobody is working in |

**The sandbox drive** (a machine daemon's guard; the portal's has none). When the sandbox root disappears:
1. The guard remembers the editors that were up and the agents mid-turn in sandboxes (from its
   last look), stops those turns, and reports.
2. It starts `ffsb-helper-mount`. If the volume holding the VHDX has less than `remountMinFreeGB`
   (30) free, it runs the clean-up and waits for space first.
3. Failed attempts retry after 2, 5, 10 and 30 minutes; after 6 it reports and stops trying
   (`machine_daemon restart` makes the daemon's guard try again; `host_recovery remount` is gone).
4. When the drive is back, it restarts those editors one at a time and sends each interrupted
   agent a resume message (check git status, re-pin Unity, continue).

The guard knows the drive's state from the moment it starts: before its first look (5 s in) it used to say
"ok", so after a reboot an agent could start on a missing F:. Now a drive missing at start blocks new agents and editors
at once, the first look reports "Sandbox drive not attached at startup" and remounts it, and between two looks a drive
that went away blocks new work immediately.

**Memory and editors.** A new editor on a machine with a guard needs `limits.minFreeRamGB` (10) free (the portal hands
that value to its own daemon). An editor whose sandbox has had no agent activity for `unity.idleStopMinutes` (120;
`sandboxIdleStopMinutes` in the daemon's `daemon.json`), and no agent mid-turn, is stopped, by the pool.

**Clean-up** runs all the time, not only in an emergency: see [Continuous clean-up](#5-continuous-clean-up)
below. The critical level also starts a pass (at most every 10 minutes). On the portal's guard that is the pass over
this computer; a daemon's guard runs none of its own ([beast-machine.md](beast-machine.md)).

**The orphan headless-browser reaper** (`server/reaper.ts`). Scripts that drive a headless browser
(screenshots, Playwright checks) sometimes die or hang and leave it running. Agents may not end
browser or node processes by hand (the guard), so a guard does it: once at startup, then every
`hostGuard.reapEveryMinutes` (15). Since w510 that is BEAST's daemon's guard; the portal's does not reap
(`server/index.ts` wires no `reap`). It only matches automation browsers:
- anything under Playwright's own folder (`%LOCALAPPDATA%\ms-playwright\...`; its WebKit carries no
  profile on the command line), or
- Edge, Chrome or Firefox started `--headless` with a profile under the temp folder.

The user's own browser, this server and Claude processes are never matched. A matched browser is
reaped when it has run longer than `hostGuard.reapBrowsersAfterHours` (3; 0 turns the reaper off),
or when whatever started it has been gone for 10 minutes. A node script driving it goes too, once
it is older than the limit. The whole process tree ends and its temp profile is deleted. Each
action is logged, reported as a `[host]` message and push, and shown as `lastReap` in
`system_status`. Profiles left without a process (`edge-*`, `playwright_*dev_profile-*`) are removed
by the clean-up once untouched for an hour.

**The recovery self-test** (`host_recovery` "selftest", which detached the drive through `ffsb-helper-detach` and
timed the reattach) was removed with the portal's drive watch in w510. `ffsb-helper-detach` stays installed.

The orchestrator can set `hostGuard.devDriveVhdx` (kept as a clean-up keep entry; the portal does not mount it) and the
clean-up settings (below) with `set_app_config`, and act by hand with `host_recovery cleanup`. `system_status`
and the sidebar's meters show the portal's guard: one disk meter per watched volume in its guard colour, and a banner
while disk space is low. A machine's guard reports reach the same places as `[host <machine>] …`.

### On BEAST's daemon (w466)

BEAST's sandboxes run on its own machine daemon ([beast-machine.md](beast-machine.md)), and the portal is moving to a
VM on the FFBox host ([portal-on-ffbox-host.md](portal-on-ffbox-host.md)). So the parts of this guard that are about
BEAST's sandbox drive run in that daemon (`machine/hostGuard.ts`, decided as D11). They use the same decisions
(`HostHealthMonitor`), against the daemon's own pool, agents and link:

- **The drive:** the watch on the sandbox root (F:), and the remount through `ffsb-helper-mount` (at once, then 2, 5,
  10 and 30 minutes, six attempts, with `remountMinFreeGB` on the VHDX's volume). Then the editors that were up are
  started again, and the agents that were mid-turn in sandboxes are told to resume.
- **Gating:** while the drive is gone or disk space is low, the daemon refuses new sandbox agents and editors with the
  reason.
- **The disk levels** over the sandbox root and `hostDiskPaths`, and **the headless-browser reaper**.
- **Its reports** reach the portal (`host_report`, queued while the link is down) and go to the dispatcher and the
  push notifications as `[host beast] …`. Its state is on the machine's record (`host_health`).

The daemon gets these settings in its `daemon.json` at deploy (`hostGuard`, from this config's `hostGuard`,
`hostDiskPaths` and `limits.minFreeRamGB`), only as the portal's own host. It keeps them when `convert_machine` makes
it an ssh machine. The helpers are Windows-only, so elsewhere the guard does not start.

**One guard per drive** (w510): the portal's guard never owns a drive (`watchDrive: () => false`, `server/index.ts`).
It measures its own disks and does not watch or remount BEAST's drive, bring that daemon's sandboxes back, or reap. (From
w466 until w510 it took the drive over when the daemon had no guard: an older daemon, or none. A daemon from before
w466 now has no guard, so nothing watches its drive; redeploy it.) What the daemon does not run is the clean-up: that
is the portal's for BEAST, since BEAST's daemon cleans nothing itself (`machines.cleanupFor`), and `machines.cleanup` on
the other machines. Nor the idle-editor stop, which is its pool's. The portal's `host_recovery` reaches none of this: a
daemon's guard that gave up (six failed mounts) starts again when the daemon restarts (`machine_daemon restart`).

## 3. The VHDX policy

A dynamically expanding VHDX grows as its volume is written and never shrinks by itself. On
2026-09-24 the file was 245 GB while the volume inside used 126 GB. Growing into the last free
space on C: is what made Windows drop it.

- **Watch the host volume**, not only the Dev Drive: `hostDiskPaths: ["C:/"]`.
- **Compaction needs `Optimize-VHD`**, which comes with the Hyper-V PowerShell module. Without it the
  only built-in tool is `diskpart compact vdisk`, and that finds unused space through the NTFS file
  system inside the disk. The Dev Drive is ReFS, so it reclaims nothing: on 2026-09-24 a retrim plus
  diskpart compaction left the file at 245.6 GB although the volume used 129 GB. The helper now refuses
  instead of detaching the drive for nothing. To make compaction work, install the module once as
  administrator (for example `Enable-WindowsOptionalFeature -Online -FeatureName
  Microsoft-Hyper-V-Management-PowerShell -All`, which also enables the Hyper-V components it depends
  on; reboot), check `Get-Command Optimize-VHD`, then compact at idle. After a retrim, Optimize-VHD's
  Full and Pretrimmed modes reclaim the blocks ReFS released. Whether ReFS block cloning keeps shared
  extents allocated does not matter here: the volume's own "used" figure already counts them once.
- **Without the module**, the realistic choices are: keep the growth harmless (the host guard's C:
  thresholds, which now stop new work long before the VHDX can hit a full C:), or rebuild the drive at
  a planned moment. A rebuild means a new, smaller VHDX (a fixed-size one never grows at all) and moving
  the sandboxes into it. That costs the block-clone sharing of the Library copies, so recreate
  sandboxes from the seed there rather than copying them.
- **Hand freed space back**: `ffsb-helper-trim` (online), then **compact**, both by hand at BEAST
  (`schtasks /run /tn ffsb-helper-trim`, then `ffsb-helper-compact`). Nothing detaches the drive automatically (since
  2026-09-24; the old `hostGuard.compactWhenReclaimGB` idle policy is gone and the key is retired: a config that sets it loads and ignores it, w755). Until w510 these
  were `host_recovery` actions, which refused while any editor was up or any agent on the host was busy
  (`HostHealthMonitor.detachRefusal`) and told the guard that the drive was offline on purpose. Now only the helper
  checks: it refuses while a `Unity.exe` has a project on the drive. Nothing tells BEAST's daemon's guard, which by
  `HostHealthMonitor.sandboxDrive` reports the drive lost when it goes: stop the daemon (`machine_daemon stop`) and its
  agents first.
- **Cap the maximum size** to what C: can hold, keeping `warnFreeGB` in reserve. Today the VHDX may
  grow to 900 GB on a 1.8 TB disk shared with everything else. Lowering the maximum means shrinking
  the partition inside and then the virtual disk (`Resize-Partition`, then `Resize-VHD`; Hyper-V
  tools, administrator, drive offline). It is a planned maintenance step, not something the guard
  does.
- **Memory is disk too**: an automatically managed pagefile grows on C: under memory pressure,
  exactly when things are already tight. A fixed pagefile (`-PagefileGB`), fewer concurrent editors
  (`max_unity` on BEAST's machine record, `limits.minFreeRamGB`) and stopping idle editors keep that growth away.

## 4. Watched from outside (the outside watchdog)

Everything above runs on BEAST, so none of it can report a power cut or a machine that booted with nobody
logged in. A Mac watches it instead: the daemon of the watching machine (`m5` by default) checks BEAST every
60 s, independent of it (`machine/outsideWatch.ts`).

- **Checks:** `GET <publicUrl>/api/health` (no login; up when it answers `{ ok: true }`) and a ping of the
  health URL's host (`tailscale ping`, else plain `ping`).
- **Alerts** go to the user's phone through [ntfy](https://ntfy.sh) (no account): after 3 misses in a row
  "BEAST down since HH:MM", or "BEAST up, portal down" when the machine answers ping but the portal does not
  (booted with nobody logged in, since automatic logon is off, or the app did not start). A change between
  those two sends a new alert; recovery sends "BEAST back (down since HH:MM, N min)". Subscribe to the topic
  in the ntfy app (iOS/Android, "Subscribe to topic", server ntfy.sh). `system_status` names the topic.
- **Wake-on-LAN:** once BEAST has not answered a ping for 5 minutes, the Mac sends a magic packet to its
  MAC (UDP ports 9 and 7, to the LAN's broadcast address and 255.255.255.255), again every 15 minutes while
  it stays down. It only works with Wake-on-LAN enabled in BEAST's BIOS (and the Mac on the same LAN);
  otherwise it is harmless. Not sent while BEAST answers ping (it is on, just not logged in).

The portal keeps the state in `<dataDir>/outside-watch.json`: the ntfy topic (random, made once; anyone who
knows it can read the alerts, so keep it private) and BEAST's LAN adapter (the one with the default IPv4
route: MAC, address, broadcast), read at start and every 6 hours while BEAST is up. It sends the config to
the watching machine's daemon when it connects and whenever it changes (protocol message
`outside_watch`); the daemon keeps it in `~/.ff-factory/outside-watch.json`, so the watch goes on while
the portal is down. Other machines are told they do not watch (their copy is removed).

Config (`config.json`, all optional): `"outsideWatch": { "machine": "m5", "healthUrl": "...", "host":
"...", "ntfyServer": "https://ntfy.sh", "enabled": true }`. Without `publicUrl` the watch takes the address the
other machines reach the portal at (their `portal_url`, `watchedPortalUrl`), never the portal's own host as a machine
(`beast`, local), whose daemon uses `http://127.0.0.1:<port>`; that machine is never the default watcher either, since
it goes down with the portal (w424: after `add_machine beast local` the m5 checked `http://127.0.0.1:8790/api/health`
and pinged itself). Without any of them (and no `healthUrl`) there is nothing to watch. The Macs get the watch with
the daemon: they redeploy themselves when idle after an update.

## 5. Continuous clean-up

On 2026-09-28 BEAST's guard refused new agents at 75 GB free on C:, and `host_recovery cleanup` freed
0 GB: it only knew browser profiles, test scratch and agent clones, and it ran only below the critical
level, long after the warn level (80 GB) had stopped the work. What filled the disk was elsewhere: Unity
Libraries of projects nobody had opened for over a year (63 GB), an Actions runner's checkout idle since
August (46 GB), Claude Code's `bash-edit-diff` snapshots in `%TEMP%\claude` (14.5 GB in three days), a
sandbox's `Builds` (78 GB on F:), and build archives in `ff-worker` (27 GB). Nothing cleaned the Macs at all.

Now the host guard and every machine daemon clean up by themselves (`server/cleanup.ts`; the daemon side in
`machine/daemon.ts`), with the same code on Windows and macOS:

- **A pass every hour** (`everyMinutes`, 60).
- **A pass every 15 minutes while free space is below the soft threshold** (`softFreeGB`), which also runs
  the rules that empty whole caches. On BEAST the soft threshold defaults to `warnFreeGB` + 40 = **120 GB**,
  so clean-up works hard well before the hard block at 80 GB; on the machines it is **80 GB**. The volumes
  measured are the disk's: the home folder's, (host) the data folder's and `hostDiskPaths`, (machine) the clone's
  and the sandboxes'; the fullest one counts. A RAM-backed filesystem (tmpfs, ramfs) never counts, and the temp
  folder is shown apart (`temp` in the summary: RAM, or a disk volume of its own) unless it is on that disk (w566:
  the portal VM's `/tmp` is a tmpfs of half its RAM, and as "the disk" it read 1.9 GB free while the disk had 101 GB).
- The critical level, a sandbox drive waiting for space, `host_recovery cleanup` and `machine_cleanup` run
  a pass at once, with every rule.

**The rules**: each is an allowlisted folder and an age; an entry goes only when nothing anywhere inside it
changed for that long (a bounded walk, so a folder something still writes to stays).

| Rule | Where | Goes when untouched for |
|---|---|---|
| test and browser scratch | temp: this app's own test folders (`ffsb-voice-*`, `scenes-??????`, …), headless-browser profiles | 1 h |
| agent temp | temp: `ffa-<session>`, each agent's own TMP (below) | 2 h, and never while its session runs |
| agent clones | temp: `fff-*`, `ffsb-*` with nothing uncommitted or unpushed | 3 days |
| anything else in temp | temp (not Claude Code's folder); a clone only when fully pushed | 7 days |
| Claude Code edit snapshots | `<temp>/claude*/bash-edit-diff/*` | 12 h |
| Claude Code task output | `<temp>/claude*/<project>/*`, and `/tmp/claude-<uid>/*/*` on a Mac | 3 days |
| Actions runner jobs | `actions-runner*/_work/*` in the home folder (and `C:\`), except `_tool`, `_actions` | 14 days |
| sandbox builds (this host's own daemon's) | `<sandboxRoot>/*/Builds/*` | 7 days |
| build archives | `~/ff-worker/*.tar`, `*.tgz`, `*.tar.gz`, `*.zip`, `*.bundle` | 7 days |
| playtest output | the game's `Never Games/finalfactory*/PlaytestSessions/*` (screenshots, recordings) | 14 days |
| crash dumps | Windows: `%LOCALAPPDATA%\CrashDumps`, `%TEMP%\Unity\Editor\Crashes`; Mac: `~/Library/Logs/Unity` crashes | 2 days |
| macOS crash reports | `~/Library/Logs/DiagnosticReports` | 14 days |
| old logs | Unity editor logs; the sandboxes' rotated editor logs beyond the newest three | 7 days |
| Unity GI cache | `LocalLow\Unity\Caches\GiCache`; Mac `~/Library/Caches/com.unity3d.UnityEditor/GiCache` | 7 days |
| Unity package cache | `Unity/cache/packages/*` | 30 days (a whole cache: below the soft threshold, 1 day) |
| Xcode DerivedData | `~/Library/Developer/Xcode/DerivedData/*` | 3 days (6 h below the soft threshold) |
| Playwright browsers | `ms-playwright/<browser>-<build>` that a newer build of the same browser replaced | 7 days |
| npx, Homebrew downloads | `npm-cache/_npx`, `~/.npm/_npx`; `~/Library/Caches/Homebrew` | 7 / 14 days |
| whole caches, below the soft threshold only | npm `_cacache`, NuGet HTTP caches, pip, uv, Go build cache | 1 day |
| stale Unity Libraries | `<project>/Library` up to three folders below the home folder, for a project not opened (its Library entries, Temp, Logs, UserSettings) for `libraryDeleteDays` (180); never while `Temp/UnityLockfile` exists, never a linked Library (a ParrelSync clone) | 180 days; **reported** from 30 (`libraryReportDays`) |
| age rules | `hostGuard.cleanup.ageRules` | as configured |

**On a machine with a worker install, a rule only removes what is inside the install folder** (w896, lothsahn: "in general we should
only be clearing data in the install folder for the worker"): the rows whose folder is outside it (system temp, crash dumps,
Unity's and the tools' caches, the game's data folder, `~/ff-worker`, runner jobs) are measured and listed, not removed; see
[Where clean-up may delete](#where-clean-up-may-delete-w896).

**Never deleted**, whatever a rule says (`neverDelete`, checked again right before each removal):
a drive root, the home folder and its top-level folders; system folders (`C:\Windows`, `Program Files`,
`ProgramData`, `/Applications`, `/System`, `/Library`, …); the sandbox root and every sandbox (a Builds
folder's entries excepted), the standing agents' folder, the base clone, this app and its data, protected
paths, a machine's clone, daemon folder and Unity; anything that is or holds a git repo, unless the rule
says otherwise (pushed agent clones, runner checkouts, this app's test scratch); `.claude` (settings,
transcripts), `.ssh`, `.gnupg`, `.aws`, `.config`, keychains and names that look like secrets;
`ff-local-backups`; `~/torque`; anything named like lab or audit artifacts (`DeterminismAudit`,
`ff-audit-artifacts`, `lab`); Steam and Unity installs (a Unity version nothing uses goes by the own-leftovers rule below); `.vhdx`/`.vhd` files (the F: VHDX); and the temp
folders of agents running now. **In use**: besides the age walk, each entry is renamed before it is
deleted. On Windows a folder with a file open inside cannot be renamed, so an entry in use is skipped
whole instead of half removed; a removal that fails after the rename leaves `<name>.ffclean-<n>`, which
the next pass removes.

**Per-agent hygiene.** Every agent on a machine gets its own temp folder,
`<temp>/ffa-<session>` (under the machine's `temp_dir` when it has one), as TMP, TEMP and TMPDIR. (`sessionTempEnv`, set by
the daemon, `machine/daemon.ts`; the portal's orchestrators never had one, and its own workers, which did, are gone
since w510.) It goes
when the session is removed, and two hours after the session stopped otherwise. One exception on Windows (w603):
the folder Git Bash maps `/tmp` to. Git for Windows mounts `/tmp` at the Windows temp folder of the user's first MSYS
process and keeps that mount while any MSYS process of the user runs, so it is often some agent's `ffa-<session>`;
removing it makes every bash print `could not find /tmp, please create!`. The daemon asks `cygpath -w /tmp` every
5 minutes and before each clean-up pass, keeps that folder, and makes it again if anything removed it
(`server/gitBashTmp.ts`). Every sandbox worker's brief (`DISK_HYGIENE` in `server/agents.ts`, w626) tells it to put
builds, recordings and screenshot sets there, and to remove everything it made (builds, Captures, recordings, extra
worktrees and clones, save copies, the player slots nobody holds) before it reports a request done.

**Visibility.** Every pass appends one line to `cleanup-log.jsonl` (the app's `dataDir` on the host, the
daemon's folder on a machine): when, why, free space before and after, each entry removed with its size
and rule, and what was skipped. `system_status` shows the host's last pass, `list_machines` each
machine's, and the dashboard's meters list every computer's (hover for the biggest entries). A pass that
leaves free space below the soft threshold reports the biggest remaining consumers (the home folder's,
LocalAppData's and the temp folders' children, files at the drive root such as the VHDX) and the stale
Unity Libraries, as a `[host]` message or `[machine <id>]` message to the orchestrator plus a push, once
per episode and at most once a day while it lasts. Passes that are fine say nothing.

**Settings** (`set_app_config`, applied at once): `hostGuard.cleanup.everyMinutes` (0 = only below the
soft threshold, else 15-1440), `hostGuard.cleanup.softFreeGB` (above `warnFreeGB`), and for the machines
`machines.cleanup.everyMinutes` / `machines.cleanup.softFreeGB`, optionally with `machine` for one
machine (`{ "*": 80, "m3": 40 }` in config.json). The ages are in `hostGuard.cleanup` in config.json
(`tempAnyOlderThanDays`, `sessionTempHours`, `claudeTempDays`, `runnerWorkDays`, `buildsOlderThanDays`,
`playtestDays`, `libraryReportDays`, `libraryDeleteDays`, `cloneOlderThanDays`). The machines use the
defaults.

### Stale build and run output (w459)

Until 2026-10-05 a person asked for every clean-up of build output: w451 freed 42 GB of stale player builds on
LothDesktop after its D: fell to the 50 GB guard and blocked new editors, and BEAST's sandboxes held about 39 GB in
their `Builds/` folders. The same pass now removes that output by itself (`server/staleOutput.ts`), on this host's
guard (its own daemon's sandboxes, and the base clone) and on every other machine's daemon (its sandboxes and its
main clone, where no agent works since w536 but old output may lie): once a day (`everyHours`, the first turn a full day after the clean-up started, never right at a
deploy), on every pass while free space is below the soft threshold, and on every pass asked for.

**What goes**, and only these (an allowlist of folders in each place, then an attribution):

| Where | Goes when |
|---|---|
| `Builds/<entry>` (any case) and `.nightly-builds/<entry>` named after requests (`w95`, `w393-facing`) | every request it names is merged, done, rejected or cancelled in the ledger, and nothing in it changed for `untouchedHours` (24) |
| `Builds/<sha>[-win\|-mac]`, `.nightly-builds/<sha>-<platform>` | a player build of one commit (rebuildable), untouched for `shaBuildDays` (2) |
| `.nightly-builds/runs/<run>` | named after closed requests as above, else untouched for `runRetentionDays` (14) |
| the nightly lab (`FF_NIGHTLY_ROOT`, the install folder's `nightly/`, or `nightlyRoots`; the old default places outside the install folder are gone, 2026-10-10) | `builds/` beyond the newest `nightlyKeep` (2), `runs/` and `logs/` past `runRetentionDays` |
| a sandbox's `Temp/` | its editor is known to be stopped, no `Temp/UnityLockfile`, untouched for `tempHours` (6) |
| a sandbox's `Logs/<file>` | its editor is known to be stopped, untouched for `logRetentionDays` (14) |

**Never**: anything changed within `untouchedHours`, anything in use by a running agent, anything holding a git repo
(listed instead, with whether it has uncommitted or unpushed work), and every folder of a place not in the table:
`Library`, `Assets`, `Inbox`, `.git`, saves, backups (`ff-local-backups`, `~/ff-backups`), people's own files. The
clean-up's guard (`neverDelete`) applies to every entry, again right before it is removed. A request still open, or
stalled (its person decides), keeps its output. Output it cannot attribute (a `Builds/perf` from nobody knows which
request, a request the ledger does not know, a scratch clone) is **listed, never removed**: the dashboard's clean-up
line counts it, its hover and `cleanup_log` name each with its size. These rules replace the older
`buildsOlderThanDays` rule for a sandbox's `Builds/` (any entry untouched for 7 days went, attributed or not); it
applies again only with `mode` off. The daily turn is kept on disk (`cleanup-state.json` in the app's data folder or
the daemon's folder), so a computer restarted or redeployed more often than daily still gets it.

**The ledger's facts** reach each daemon over its link (`cleanup_context`: the open and closed request ids) at
connect and every 10 minutes; facts older than 48 hours are not acted on, and request-named output is then listed.

**Dry runs and the log.** `host_recovery` "cleanup" and `machine_cleanup` take `dry_run: true`: the full list of what
the pass would remove (stale output included) with sizes and why, and what it would keep for a person, removing
nothing. Every pass is logged in full (path, size, why) on the computer (`cleanup-log.jsonl`) and, for a machine, on
the portal too (`data/cleanup/<machine>/cleanup-log.jsonl`); `cleanup_log` shows a computer's newest passes.

**Settings**: `hostGuard.cleanup.staleOutput` (this host) and `machines.cleanup.staleOutput` (every machine), with
`set_app_config`, applied at once: `mode` (`on` default, `dry-run`: measured and reported, nothing removed, or
`off`), `everyHours` (24), `untouchedHours` (24), `shaBuildDays` (2), `runRetentionDays` (14), `logRetentionDays`
(14), `tempHours` (6), `nightlyKeep` (2), `nightlyRoots`. Tests: `server/staleOutput.test.ts` (each keep and delete
rule), `server/machineSandboxes.test.ts` (a dry run through a daemon).

### FF Factory's own leftovers (w626)

On 2026-10-07 the m3 drifted under its 50 GB guard holding about 78 GB of what FF Factory itself had left there: old
player slots outside the install folder, an old agent worktree, and Unity editor versions no project used. A worker
found them (w596) and asked people for a go instead of removing them, and the question reached Ben and Lothsahn. Ben:
"no YOU free up disk space, like you are instructed to in this harness. stop making us tell you to do it." Now a
machine's daemon removes these by itself (`server/ownLeftovers.ts`, wired in `machine/daemon.ts` `ownLeftovers`) in
every pass while free space is below the soft threshold, in every pass asked for (`machine_cleanup`) and in dry runs.
It reports what it removed in the pass's log like every other rule; it asks nobody.

| What | Where it looks | Goes when |
|---|---|---|
| player slots (`scripts/nightly/player_slots.py` in the game repo) | every slot root the machine may have: `<root>/players` of a worker root, the root in the slot config (`%ProgramData%\FinalFactory\player-slots.json`, `~/.config/finalfactory/player-slots.json`) (the script's old default places outside the install folder are gone, 2026-10-10) | a `slot*` folder holding a player copy (or an earlier fill's `trash-*`) with no live lease (a lease lives as the script judges it: younger than 12 h and, on this host, its pid alive) and nothing inside changed for 24 h. The whole slot folder goes; the next launch makes it again at the same path, so the firewall rule that names it still fits |
| agent worktrees | the linked worktrees of the machine's clone and a worker root's `repo/` (`git worktree list`) | not a sandbox nor holding one, not locked, not inside a sandbox an agent works in now, no process naming it, unused for 2 days (its git HEAD, index and reflog, its top-level entries, a Unity project's Library entries, Temp, Logs, UserSettings), and nothing uncommitted, untracked or on no remote. One with work of its own is **listed** for its owner, never removed. Inside the clone or the sandbox root only a Claude Code worktree (`<x>/.claude/worktrees/<name>`) is taken, so a sandbox the pool does not list is never picked; paths are compared in their real form (Windows 8.3 short names and links resolved). After the removal `git worktree prune` drops git's record; the branch stays |
| Unity editors | Unity Hub's editor folders (its chosen install path and the defaults), the machine's `unity_editor_root`, and the folders of the editors the Hub lists | a `<version>` folder holding `Editor/Unity.exe` or `Unity.app` whose version no sandbox's or the main clone's `ProjectSettings/ProjectVersion.txt` names, nor the clone's `HEAD`, `origin/develop` or `origin/master`, nor a Unity project up to three folders under the home folder opened within 30 days (a person's own), and that no process runs from. When no version could be read at all, none goes |
| finished agents' temp folders | the temp folders (the regular `agent-temp` rule above) | two hours after the session stopped, never while it runs |

**Checked again right before each removal**: a slot is planned again (a lease taken meanwhile keeps it), a worktree's
last use and the processes are read again, and an editor that a process started from meanwhile stays. The process list
failing means no worktree or editor is judged in that pass. Each entry is renamed before it is deleted, as above.
Never: a sandbox, the clone itself, anything the guard keeps (`neverDelete`: protected paths, the daemon's folder,
secrets, backups), a person's own files (only the exact shapes in the table are looked at). On Windows an editor under
`Program Files` needs administrator rights the daemon does not have: its removal fails and the log says so (the
editors on our machines are in a Hub folder the user owns, or `unity_editor_root`). The portal's own host as a machine
cleans nothing itself (`machines.cleanupFor`); a `machine_cleanup` there still runs these rules. Tests:
`server/ownLeftovers.test.ts` (each pick and each keep, removal and pruning with real git).

**People are never asked to free disk.** A pass that cannot get back above the soft threshold says, in its notice to
the dispatcher, to file clean-up work for that computer, and that such work deletes only inside the worker install folder (w896); the dispatcher's and the orchestrators' briefs say low disk is
fixed by `machine_cleanup` and a clean-up worker on that machine, never by asking its owner (`server/agents.ts`), and
every sandbox worker's brief carries the clean-up of its own leftovers before it reports a request done
(`DISK_HYGIENE`). The worker's checklist is the ff-agents evidence-gate lesson `clean-up-after-yourself.md`.

What clean-up cannot fix is reported, not removed: user data (OneDrive, Videos, Downloads), the audit
artifacts, and on BEAST the Dev Drive VHDX, which grows but never shrinks by itself (634 GB for 334 GB used
on 2026-09-28): compact it by hand (section 3).

### Install-folder leftovers (w899)

On 2026-10-10 LothDesktop's D: fell from 104 GB to 60 GB free while the clean-up kept most of the cause as "not
attributable": w876 (the disk clean-up that day) removed it by hand. The biggest item was one Claude task `.output`
file of 99.6 GB, written for a day by a leftover `python -` whose heredoc was lost in an `eval`, so Python opened its
interactive console and looped on `WinError 123`; deleting the file freed nothing until the process ended. Lothsahn
(2026-10-10): "in general we should only be clearing data in the install folder for the worker". The rules in
`server/installLeftovers.ts` (wired as the daemon's stale-output plan, merged with `planStaleOutput`'s in
`machine/daemon.ts`) take these, only inside the worker root (`cfg.root`; a machine without one takes nothing), on the
stale-output schedule (daily, and in every pass while free space is low, asked for, or a dry run):

| What | Where | Goes when |
|---|---|---|
| per-commit builds | each sandbox's `.nightly-builds/cache/*` and `Builds/cache/*` | beyond the newest 2 (by last activity), once idle 6 h |
| benchmark builds, captures | `Builds/bench*`; `.nightly-builds/clips`, `shots` | untouched 2 / 3 days |
| the nightly lab | `<root>/nightly`: `builds/*` beyond the newest 2, `runs/*` but the newest, `rehearsals/*`, `logs/*` | idle 6 h / 3 days / 2 days / 3 days |
| stale scratch | `<root>/scratch/*` | untouched 3 days and no open request (ledger context) named in it |
| stopped sessions' temp | `<temp root>/ffa-<session>` | the session is not live (the guard's inUse), untouched 2 h; a clone inside with unpushed work is listed, kept (the app's own `ffbox-test-*` fixture repos do not hold it) |
| runaway task output | `<ffa>/claude…/<project>/<session>/tasks/*.output` past 2 GB | a stopped session's: the file goes **and the processes naming that session's folder (and their children) are ended first**, `taskkill /T /F` or SIGKILL (`machine/hostWatch.ts` `killTree`), logged. A live session's is only **listed** |

`StalePlan.strays` carries the processes; `cleanupPass` ends them just before the items go, never in a dry run, and the
rest of the pass is unchanged (the guard, the rename, the log). The defaults are `INSTALL_LEFTOVER_DEFAULTS`
(`keepBuilds`, `buildUntouchedHours`, `benchDays`, `captureDays`, `nightlyRunDays`, `rehearsalDays`,
`sessionTempHours`, `scratchDays`, `outputCapGB`); the portal does not send them yet. Never looked into: `Library`,
`Assets`, `ProjectSettings`, `Packages`, `Inbox`, `.git`, the sandbox folders themselves, the nightly lab's scripts and
`state`, anything outside the root. A worktree with uncommitted work is never a candidate (only the named children above
are). Tests: `server/installLeftovers.test.ts`, laid out from the recorded listing
`server/fixtures/lothdesktop-2026-10-10.json` (what each rule takes and keeps, the strays named from the real
command lines, a dry run and a real pass). The `python -` itself is guarded at the harness (the ff-agents lesson
`python-dash-heredoc.md`: a Bash command must not feed `python -` through `eval`/a heredoc that can be lost), the daemon
is the backstop that frees the space.

### Where clean-up may delete (w896)

**The rule** (lothsahn, 2026-10-10: "Why are you clearing C: on LothDesktop?  How much space are the unity caches using?  In
general we should only be clearing D:", then "Sorry, in general we should only be clearing data in the install folder for
the worker"): clean-up deletes only inside the machine's worker install folder, the `root` of its `root.json`
(`D:\work\ffw` on LothDesktop, `F:\ffw` on BEAST, `~/ffw` or `/Users/Shared/ffw` on a Mac; `FF_WORKER_ROOT` in every
agent's environment). Outside it a worker only **measures and reports** sizes, and lists every setting, script or
tool that makes FF Factory write outside the folder, so the write can be moved inside (a request of its own). A brief that
tells a worker to delete outside the folder is wrong, whoever wrote it.

**What happened.** On 2026-10-10 w876 (LothDesktop's low-disk clean-up) deleted on C:, outside `D:\work\ffw`: dotnet
workload temp, the Unity Hub installer, Temp entries past three days, `LocalLow\Never Games\finalfactory` test output and
`~/.claude` transcripts past seven days (sourced from worker 37a50761's transcript). The dispatcher's own brief told it to;
w892 was then filed to clear outside the folder too, and became measure-only. The w626 rule above ("remove FF Factory's own
leftovers, never ask a person") had no boundary, and the notice built on it listed `C:\Users\...\AppData` as "biggest
remaining", which reads as an invitation.

**Where it is written down, and what enforces it** (every layer says the same, quoting lothsahn):

| Layer | Where | What it does |
|---|---|---|
| every worker's brief | `DISK_HYGIENE`, `server/agents.ts` | delete only inside the root; measure and report outside; a brief that says otherwise is wrong; only a save copy in the game's saves folder is removed outside |
| the dispatcher's and the orchestrators' instructions | `server/agents.ts` (the low-disk lines of both) | a clean-up worker's brief says the same and never contains a delete outside the folder; `list_machines` shows each machine's install folder (`describeDirs`) |
| the notice "Clean-up cannot free enough disk space" | `describeShortfall`, `server/cleanup.ts` | states the rule with the machine's root, and tags every "biggest remaining" consumer `[inside the install folder]` or `[outside it: measure only]` |
| the daemon's own pass | `cleanupPass` `root`, `fenceToRoot`; `machine/daemon.ts` | on a machine with a root, only entries strictly inside it are removed, whatever rule picked them; the rest is measured and listed in the pass's log, `machine_cleanup` and the dashboard ("Kept, for a person") |
| a worker's shell | `server/rootFence.ts` via `sandboxGuard` (`workerRoot`, set from the machine's `root`) | refuses `rm`, `rmdir`, `del`, `rd`, `Remove-Item`, `find -delete`, `xargs rm` and a listing piped into a removal that name a path outside the root |
| the harness lesson | ff-agents evidence-gate `lessons/delete-only-inside-the-worker-root.md` and its delete checklist | the check a worker meets before any delete |

**The daemon's own rules, by place** (the audit asked for in w896; `server/installFolderFence.test.ts` pins this table for
a root-install shape). Before w896 every row below the first removed things on C: that FF Factory does not keep inside the
root. Now only the first group removes anything on a machine with a root.

| Group | Rules (`id`) | Where | Now |
|---|---|---|---|
| **inside the root** | agent temp, temp scratch, agent clones, old temp (`agent-temp`, `temp-scratch`, `temp-clones`, `temp-old`), Claude Code task files (`claude-edit-diff`, `claude-temp`) in the agents' temp, the sandboxes' `Builds`, `Temp` and `Logs` (`sandbox-builds`, stale output), the nightly lab, player slots and agent worktrees under the root | `<root>/tmp` (the agents' `TMP`), `<root>/sandboxes`, `<root>/players`, `<root>/nightly` | removed, as before |
| system temp, crash dumps | the same `temp-*` and `claude-*` rules on `%TEMP%` / `/tmp`, `unity-crashes`, `crash-dumps`, `diagnostic-reports` | `%LOCALAPPDATA%\Temp`, `%LOCALAPPDATA%\CrashDumps`, `~/Library/Logs` | **listed, not removed** |
| Unity's own stores | `unity-logs`, `unity-gi-cache`, `unity-cache`, `unity-cache-low` | `%LOCALAPPDATA%\Unity`, `LocalLow\Unity\Caches\GiCache`, `~/Library/Unity` | **listed** |
| tool caches | `npx`, `npm-cache`, `nuget-http`, `pip-cache`, `uv-cache`, `go-build-cache`, `homebrew-cache`, `xcode-derived`, `playwright`, `edge-webview` | the user's profile and `~/Library` | **listed** |
| the game's data folder | `playtest-sessions` | `LocalLow\Never Games\finalfactory*\PlaytestSessions` | **listed** |
| other | `worker-archives` (`~/ff-worker`), `actions-work` (runner job folders), `stale-library` (Unity Libraries of projects under the home folder) | the home folder, `C:\` | **listed** |
| own leftovers outside the root | player slots outside the root (the old default places are gone, 2026-10-10), Unity editors in Unity Hub's folders, worktrees of a clone outside the root | | **listed** |

A machine **without** a root (the portal's own host, an install from before w513) is not fenced: nothing tells the daemon
which folder is the worker's. Nothing is configurable: a person who wants a rule outside the root back says so, and it
comes back as a named exception in this table. Flagged for lothsahn: on a root machine nothing now empties the Unity,
npm, NuGet, Playwright and crash-dump stores on C: by itself (they were the hourly rules above); they grow until someone
moves them inside the root or approves an exception.

**What the guard does not see**: a script, `python shutil.rmtree`, a variable it cannot expand (`rm $X`), a `$(...)`
value, a path on a mount it cannot map. It is a seatbelt like the rest of `server/guard.ts`; the instructions carry the rule,
the guard catches the plain commands. It judges sandbox workers only (`workerRoot` is in their launch spec). It applies to
every request, not only a clean-up one: a session's guard is fixed when it starts and a request can be handed to it later,
and no ledger field says which requests are clean-ups, so "during a clean-up request" cannot be told apart. A worker has
no other reason to delete outside its folder; the one it does have, the save copy it put in the game's saves folder (one
entry, never `saves/*`), is allowed.

**What a clean-up worker reports for what is outside the root**, each with a size (`du`, `Get-ChildItem | Measure-Object`):
Unity Hub's editors and installers; `%LOCALAPPDATA%\Unity` (logs, package cache, licences); `LocalLow\Unity\Caches\GiCache`;
`LocalLow\Never Games\finalfactory` (saves, `DeterminismAudit`, `AgentControl`, `TestResults.xml`, `PlaytestSessions`);
`~/.claude` (transcripts, plugins); dotnet workload temp; the system temp; the npm, NuGet, pip, uv and Playwright caches;
Windows crash dumps. For each: which setting or script makes FF Factory write there, and whether a variable could move it
inside the root (candidates, not verified here: `NUGET_PACKAGES`, `npm_config_cache`, `PLAYWRIGHT_BROWSERS_PATH`,
`DOTNET_CLI_HOME`, `UV_CACHE_DIR`, `PIP_CACHE_DIR`, `CLAUDE_CONFIG_DIR`; Unity's own folders have none and the game's data
folder has no override, [worker-root.md](worker-root.md) section 2). Moving one is a request for lothsahn to decide, not
clean-up work.

## 6. Crash-safe data files

On 2026-09-30 BEAST hard-crashed (a WHEA hardware error) while the server was saving `data/state.json`. The save wrote a
temp file and renamed it over the old one, but never flushed it to disk: after the crash the rename was there and the
data was not, so `state.json` was 4.4 MB of zero bytes. Every start failed to parse it, the supervisor backed off, and
the portal stayed down until someone restored the file from a shadow copy of 13:04:57, losing the 16 minutes after it.

**Writes** (`server/durable.ts` `writeFileDurable`). A temp file, fsynced, renamed over the old file, then the folder
fsynced (not on Windows, where NTFS journals the rename itself). A crash at any moment leaves the old version or the new
one, never a torn or zeroed file. The earlier versions stay beside it:

| Version | What it is | Age after a crash |
|---|---|---|
| `state.json.1` | the save before the current one (a hard link, not a copy) | seconds |
| `state.json.2` | takes the old `.1` at most once a minute | up to a minute |
| `state.json.3` | takes the old `.2` at most every 10 minutes | 1 to 11 minutes |

So a failure that damaged every recent write still leaves an older good one.

**Loads** (`readJsonDurable`). A file is good when it is not empty, not zero bytes, parses, and passes its schema check
(`state.json`: its lists, and an id on every entry). A damaged file is moved aside as `<name>.damaged-<time>` (never
deleted), the newest good version is written back in its place, and the server starts from it. When nothing good is
left, that file starts empty and the log says so in capitals. Every recovery goes into the restart summary the
dispatcher gets, a push ("Data restored after a crash") and a message to the owner's own orchestrator: which file, what
was wrong with it, which version was restored, when that version was saved and how much was lost. A restored `work.json`
moves its numbering on by 100, so a work item number the lost version handed out is not reused.

**How much a crash loses.** `state.json` is written at most 200 ms after a change and at most once a second, however
busy the agents are. (The old save restarted a 200 ms timer on every change, so a steady stream of session updates
could postpone it indefinitely.) The main thread serializes the state; the write and the fsync run off it.
`node scripts/bench-state-save.ts` measures it:

| Where | Sessions (size) | Main thread per save | Write + fsync (off the main thread) |
|---|---|---|---|
| BEAST (i9-14900KF, Windows) | 7,265 (5.7 MB) | 12 ms serialize, 17 ms worst stall | 23 ms |
| BEAST | 12,000 (9.5 MB) | 23 ms serialize, 24 ms worst stall | 35 ms |
| M3 Pro (BEAST's real state.json) | 7,265 (4.4 MB) | 5 ms serialize, 9 ms worst stall | 17 ms |

At most one save a second, that is under 2 % of the main thread at BEAST's size. A crash loses about a second of
`state.json`; if the disk lost the last write anyway, it goes back to `.1`, seconds earlier.

**Files covered.** `state.json` (sandboxes, sessions, standing agents, delegations, machines, settings), `work.json`
(the ledger), `intake.json`, `max.json`, `providers/*.json`, `users.json`, `api-keys.json`, `auth-sessions.json`,
`machine-tokens.json`, `wakes.json`, `usage.json`, `spend.json`, `push-subscriptions.json`, `vapid.json`,
`outside-watch.json`, `resume.json`, `alive.json`, `restart.pending.json`, and `config.json`
(whose `config.json.prev` counts as one more version). Transcripts stay append-only: a rewrite (a permission decision,
the secret scrub) is crash-safe without versions, the first append after a start completes a line a crash tore, and
zero bytes a crash left in one are skipped.

**Orchestrator memory.** Claude Code writes those files itself, so the app keeps copies instead:
`<memory root>.backup/1` to `3`, taken at start and every 10 minutes when something changed. They are copies, not hard
links: the memory guard refuses to write a hard-linked file. At startup a memory file left empty or zeroed gets its
newest good copy back and the damaged one moves to `<memory root>.backup/damaged/`. A damaged file is never backed up
over its good copy.

**The supervisor** (`scripts/supervise.ps1`) backs off at most a minute in a crash loop (it was 5), and its log line
names the error that ended each run. A damaged data file no longer causes a loop.

**Tests:** `server/durable.test.ts` (zeroed, cut off, partly written and empty files, every recent version damaged, a
writer killed at random six times mid-write, background saves under a steady stream of changes) and
`server/crashRecovery.test.ts` (the store, transcripts, memory, and the real server started on a zeroed `state.json` and
`users.json`, which comes up, answers and reports the recovery).
