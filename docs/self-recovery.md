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

**Disk levels**, with `hysteresisGB` (10) before a level clears. The portal's own host, its dedicated VM, is low below
`hostGuard.warnFreeGB` (20) and critical below `hostGuard.criticalFreeGB` (10) (w1101, lothsahn: "Let's just set the
warning to 20GB both in code and in config." and "Critical level for the portal should be 10GB"; settable with
set_app_config, critical below warn). A machine's daemon has its own levels (`disk_warn_gb`, `disk_critical_gb` in its
daemon.json):

| Level | When (any watched volume) | What happens |
|---|---|---|
| warn | below the warn level | a `[host]` message to the orchestrator and a push (kind "Host health"); on a machine's daemon, new sandbox agents and editors there are also refused with the reason |
| critical | below the critical level | also: a clean-up pass with every rule runs (at most every 10 minutes); the daemon's guard also stops sandbox editors nobody is working in |

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

### Why a Mac went offline (w1249)

Read-only, on the Mac itself once it is back. Panic and GPU reports move to `/Library/Logs/DiagnosticReports/Retired/`
within a day, so look there as well as in the folder above it.

- `panic-full-*.panic`: the file's name and `date` are when the report was written, at the next login. The panic's own
  time is `Calendar` in the panic string (an epoch in hex: `date -r $((16#<hex>))`). "userspace watchdog timeout: no
  successful checkins from WindowServer" means the GPU or WindowServer wedged and the kernel restarted the Mac.
- `gpuEvent-<process>-*.ips`: a GPU restart charged to that process (`restart_reason_desc`, e.g. "BIF0 page fault").
  `finalfactory` means a built game player.
- `ResetCounter-*.diag`: `Boot faults: wdog` is a watchdog restart, and `btn_rst` is someone holding the power button
  after a hang.
- `pmset -g log | grep "powerd process is started"` gives the login after each restart. With FileVault on and no
  auto-login (`fdesetup status`), the daemon, a LaunchAgent, runs only once its person has logged in. So the gap from
  the panic to that line is the time the Mac was dark.
- `sysctl kern.boottime` gives the boot itself, and the portal journal (`portal_logs`, grep `machine <id>`) gives when
  the portal lost and regained it.

**Asleep, not crashed** (w1547). A MacBook that sleeps with its lid closed looks like a run of outages: the portal logs
"machine <id> connected", then "no answer for ~55 s, dropping the connection" a minute later, then "offline for 30
min", and `placeAgain` words the held sandbox as "its daemon restarted at <time>" (`server/placeAgain.ts` `releaseWhy`)
though nothing restarted. Each "connected" is a DarkWake (a few seconds to 45 s awake for maintenance), and workers
placed then never get a turn. Tell it apart, read-only:

- `uptime` / `sysctl kern.boottime` (no reboot), `sysctl kern.sleeptime kern.waketime`, and the daemon's own `ps -o
  etime` (one process since the last deploy means it never died).
- `pmset -g log`: `Entering Sleep state due to 'Clamshell Sleep'` is the lid; `Maintenance Sleep` and `DarkWake from
  Deep Idle ... rtc/Maintenance 45 secs` are the hourly wakes; each portal "connected" line falls within ~5 s of one
  (the log is in the Mac's local time, the portal journal in the portal's). The `Using AC|Batt (Charge:N%)` field on
  every line gives the power history: print each change of it.
- `pmset -g ps` and `ioreg -r -k AppleClamshellState -d 1` (lid closed, battery, charge) while it is briefly up; your
  own ssh attempts wake it for a moment (`E_TKO_UNEXPECT_TCP_FLAG`), so pull everything in one parallel burst.

`caffeinate -i` (the daemon's keep-awake) and `sleep 0` stop only idle sleep. Closing the lid sleeps a Mac unless it is
on AC power with an external display (closed-display mode), so a charger that drops out ends it. On the m5 on
2026-10-19 the battery fell from 99% to 19% on battery (20:44 to 21:45 EDT) and on to 2% on AC (21:45 to 23:38: the
charger did not keep up with the load, and the source flapped AC/battery), and at 02:20 EDT the source went to battery with the lid closed:
`Clamshell Sleep ... Using AC (Charge:17%)` then `Using Batt`. It slept for the next six hours at 14 to 17% with seven
apparent drops. The fix was a charger, not code.

On the m3 from 2026-10-07 to 10-13 there were 7 outages, and each was a game client that workers had started there and
that hit w665's GPU page fault. The game repo's `player_slots.py` now refuses a multiplayer client on a Mac
(`FF_MAC_GPU_HANG_OK`), and `watchOffline` reports a machine that has been offline 30 min with work stranded on it
([machines.md](machines.md)).

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
  the rules that empty whole caches. On the portal's dedicated VM the soft threshold defaults to its warn level,
  **20 GB** (`hostSoftFreeGB`, w1101; it was warn + 40 = 120 GB for BEAST's sandbox drive, when the portal ran there and
  kept sandboxes); on the machines it is **80 GB**. The volumes
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
when the session is removed, a few minutes after its process ends (w913, below), and in the daily pass otherwise. One exception on Windows (w603):
the folder Git Bash maps `/tmp` to. Git for Windows mounts `/tmp` at the Windows temp folder of the user's first MSYS
process and keeps that mount while any MSYS process of the user runs, so it is often some agent's `ffa-<session>`;
removing it makes every bash print `could not find /tmp, please create!`. The daemon asks `cygpath -w /tmp` every
5 minutes and before each clean-up pass, keeps that folder, and makes it again if anything removed it
(`server/gitBashTmp.ts`). Every sandbox worker's brief (`DISK_HYGIENE` in `server/agents.ts`) tells it to put
everything it makes there and to leave it: since w913 workers do not clean up, the harness does (below).

**Visibility.** Every pass appends one line to `cleanup-log.jsonl` (the app's `dataDir` on the host, the
daemon's folder on a machine): when, why, free space before and after, each entry removed with its size
and rule, and what was skipped. `system_status` shows the host's last pass, `list_machines` each
machine's, and the dashboard's meters list every computer's (hover for the biggest entries). A pass that
leaves free space below the soft threshold reports the biggest remaining consumers (the home folder's,
LocalAppData's and the temp folders' children, files at the drive root such as the VHDX) and the stale
Unity Libraries, as a `[host]` message or `[machine <id>]` message to the orchestrator plus a push, once
per episode and at most once a day while it lasts. Passes that are fine say nothing.

**Settings** (`set_app_config`, applied at once): `hostGuard.cleanup.everyMinutes` (0 = only below the
soft threshold, else 15-1440), `hostGuard.cleanup.softFreeGB` (above `criticalFreeGB`; default `warnFreeGB`),
`hostGuard.warnFreeGB` and `hostGuard.criticalFreeGB` (the portal's own levels, critical below warn; w1101), and for the machines
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
request, a request the ledger does not know, a scratch clone) is **listed, never removed**: `system_status`, a computer's row hover on the dashboard and
`cleanup_log` count it, and `cleanup_log` names each with its size (the meters sheet has no clean-up lines since w1389: a disk under its soft threshold shows amber on its own bar). These rules replace the older
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
| Unity editors | Unity Hub's editor folders (its chosen install path and the defaults), the machine's `unity_editor_root`, and the folders of the editors the Hub lists | a `<version>` folder holding `Editor/Unity.exe` or `Unity.app` whose version no sandbox's or the main clone's `ProjectSettings/ProjectVersion.txt` names, nor the clone's `HEAD` or `origin/master`, nor a Unity project up to three folders under the home folder opened within 30 days (a person's own), and that no process runs from. When no version could be read at all, none goes |
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

### Workers do not clean up: the harness does (w913)

Lothsahn (2026-10-10): "Random clean up commands take a lot of approvals. Is there some way we can build what those cleanup
commands are doing into the harness (like we have for trimming the Burst Cache) so that they run every time a worker is
done, and stop asking the workers to do cleanup and need approvals?"

**Measured (beast, 2026-10-03 to 2026-10-10, the 711 local transcripts; a regex over the Bash and PowerShell commands, so a
count of clean-up statements run, not of prompts: the portal's permission events, which `scripts/cleanup-approvals.ts` counts,
are not on beast).** 1351 delete statements in 8 days (127 to 200 a day). By kind: the session's `$TMPDIR` or `/tmp` 388 (100
sessions); other recursive `rm` 263; single files in the repo 325; sandbox scratch folders 86; captures, screenshots and clips
79; save copies in the game's saves folder 61 (38 sessions); `player_slots.py prune` 57 (43 sessions); temp builds 42;
`git worktree remove` 32. Claude Code asks about `rm -rf`, a wildcard or a path outside the working folder even in the
portal's bypass mode (the session's `canUseTool` is called), so the `$TMPDIR` and scratch deletes are the ones that reached a
person: `rm -rf $TMPDIR/ff-factory $TMPDIR/ffbox $TMPDIR/*.log $TMPDIR/*.out /tmp/ffb-w901` (w901), `rm -rf $TMPDIR/ff
$TMPDIR/*.txt $TMPDIR/t.ts $TMPDIR/body.md` (w907, approved twice by Ben). On disk now (beast `F:\ffw\tmp`, `du`): 16 `ffa-*`
folders, 21 GB, the biggest 8.8, 5.3 and 3.5 GB (builds, logs, clones of closed sessions).

**What runs, and when**

| What | Where | When | Why then |
|---|---|---|---|
| everything in the worker's temp folder but git clones | `<install>/tmp/ffa-<session>` | `graceMin` (10 min) after the session's process ended AND no request waits for it (closed, or with another worker; since w1097, below: a wait for CI or a person, a stop or a pause keeps it) (`SessionSweeper`, `server/sessionSweep.ts`, a look every 30 s) | then the worker is done; the grace lets a worker that is resumed at once keep its files |
| the git clones there | same | `cloneKeepHours` (6 h) after it was done, unless a clone holds work no remote has (uncommitted, or commits on no remote: listed, kept) | a wait for CI is minutes to hours and a red check needs the clone again |
| the sandbox's own build and capture output | `<sandbox>/.nightly-builds/cache/*` and `Builds/cache/*` beyond the newest 1, `Builds/bench*`, `.nightly-builds/clips`, `shots` | when the sandbox is released, in the same `cleanup` state as the Library trim (w898; `releaseSweep` in `machine/sandboxes.ts`, limits `RELEASE_SETTINGS` in `server/installLeftovers.ts`: nothing changed in it for 15 min) | the last worker is gone and its editor down; a detached build still writing keeps its folder |
| old per-commit builds, nightly runs and rehearsals, stale scratch, runaway task output | as w899 above | the daily pass and below the soft threshold | the backstop for sessions the daemon never saw end |
| player slots nobody holds, pushed agent worktrees | as w626 above | below the soft threshold | unchanged |

**Never**: outside the install folder (the plan is inside `root`, and every item still goes through `neverDelete` and the
guard); a live session's folder; a folder a running process names (a build the worker left running: the whole sweep waits,
`mentions`); an entry changed in the last 2 minutes; Git Bash's `/tmp` (the guard's `inUse`); a clone with work nothing else
has; Library, Assets, `.git`, Inbox, the nightly lab's scripts. A session that comes back resets its clock. `daemon.json`
`sessionSweep` ({ graceMin, cloneKeepHours, quietMin }) sets the numbers; they are a guess on top of the measurements above.

**In-session, when a worker needs space now (a huge build mid-task)**: a permission rule, not a machine tool. The session
(`Session.askPermission`, `server/sessions.ts`) answers a Bash or PowerShell command itself, with no prompt, when
`tempOnlyDelete` (`server/tempDelete.ts`) says it is a list of `rm` / `rmdir` / `Remove-Item` (plus `du`, `ls`, `df`, `echo`)
whose every path is written out under the session's own `$TMPDIR` (or the `/f/...`, `$env:TEMP`, `%TEMP%` spellings of it) and
strictly inside it. Anything else goes to a person as before: the folder itself, `/tmp`, `..`, `~`, an unknown variable, a
pipe, a redirect into a file, a command substitution, a flag it does not know, a link inside the folder that leads out of it
(`realpath` of the literal prefix), a single-quoted variable. It applies only to a session whose `TMPDIR` is an `ffa-` folder.
Why a rule and not a tool: the commands stay what workers type, nothing is added to three tool lists, and the rule is a few
lines of text checks with the failing commands as tests; a tool needs a catalog entry, a schema, a portal handler and a
daemon handler. The save copies a worker puts in the game's saves folder are outside the install folder, so no sweep takes
them; the rule lets a worker remove exactly the files named `<its temp folder's name>-<name>.zip` there
(`ffa-ee5b82dc-w913-test.zip`), and a save with any other name is a person's.

**Tests**: `server/tempDelete.test.ts` (the w901, w907 and w883 commands allowed, every escape refused, a real junction),
`server/agentSession.test.ts` (the session answers an in-folder delete, asks for an outside one), `server/sessionSweep.test.ts`
(the two steps, the grace, a returning session, a process that names the folder, a live session, a clone with local work),
`server/releaseSweep.test.ts` and `server/machineSandboxes.test.ts` (the release sweep inside `cleanup`, a failing one),
`server/evidenceRules.test.ts` (the brief says leave it). **Measuring**: `node scripts/cleanup-approvals.ts <dataDir>
--since 2026-10-03 --split <deploy date>` prints, per day, the prompts a person answered and the clean-up ones by kind
(the session's own answer leaves no event, so a drop is real).

### Processes a stopped worker left running are ended (w1196, w1197)

**Why.** On 2026-10-13 biscuit ran its fans at 100% around the clock: two headless game players that workers had started
were still up 27 h and 34 h after those workers stopped and their requests closed (pid 2459040, slot1-1 under Xvfb :101,
worker a33e1437, w1072; pid 2311211, slot2-0 under Xvfb :62, worker 1290a5e0, w1025), about 6 cores between them, with 17
Xvfb displays of earlier workers beside them and a whole dbus/gvfs session of a third worker 38 h old. Nothing reaped them:
`list_sandboxes` showed "game players (not counted)", the batch reaper (w791) looks only at Unity, and an agent host's end
(w799) takes only its own process tree, which a detached player, an Xvfb started with setsid or anything reparented to init
has left. Ben (w1197): "please update the fff harness to ensure everything is properly cleaned up so we arent wasting system
resources on our machines after work is done".

**Whose a process is** (`machine/leftovers.ts`). Every process a worker starts inherits its environment, `FF_SESSION_ID` and
`FF_MACHINE_ID` included (`server/agents.ts`), wherever it went since: a new session or process group, a detached launch, a
parent that exited. The daemon reads it from the process itself: `/proc/<pid>/environ` on Linux, `ps -E` on a Mac, the
process's environment block (its PEB, through Windows PowerShell 5.1) on Windows. Not its parent or process group (a
detached player has left both) and not a job object (it would need a native helper holding a handle across daemon
restarts). Two fallbacks: a player started through the player slots names its session in its lease (`player_slots.py`,
`session`), and a program run from a worker's temp folder (`<install>/tmp/ffa-<session>/...`) names it in its path.

**When it ends** (looked at once a minute; a process must have been seen by two looks):

| Its worker | Ended |
|---|---|
| its process runs (mid-turn or between turns) | never |
| stopped, no request waits for it | 2 min after it stopped |
| stopped, a request still waits for it (CI, a person, a pause) | 10 min after it stopped |
| stopped with a pending wake_me check-in | not before the check-in is due plus 10 min |
| none named: a game player under a player slot whose starter is gone, whose slot no other lease holds and whose sandbox has no live worker | 10 min after it was first seen so |

SIGTERM first, SIGKILL for what still runs 5 s later, children before parents; a stopped batch Unity's stale
`Temp/UnityLockfile` goes when no Unity has the project open. Each end is logged (`leftovers: ended N process(es) left by
worker <id> (sandbox <id>): game player slot1-1 pid ..., Xvfb pid ... Why: ...`, with the command lines) and told to the
orchestrators as a `sandbox_event` ("Leftover processes: ..."). `list_sandboxes` and the dashboard's meters (hover; a
"leftover players" flag) show each game player with its owner, its age and when it ends.

**Never ended:** anything while its worker's process runs; an interactive Unity editor and what it started (the sandbox
pool stops idle editors; a person's editor is never ours); a process that names the main clone or the daemon's own folder
(agent hosts are `hostWatch.ts`'s); a process carrying another machine's id, or with no machine id and a session this
machine never ran (the portal's orchestrators, where a daemon shares the portal's host); a shared build server
(VBCSCompiler, MSBuild nodes, bee) while it still uses CPU; anything before the portal's welcome since the daemon started.

**Where the numbers come from.** 10 min for a stopped worker a request waits for: sourced, the session sweep's own grace for
its temp folder (`SWEEP_DEFAULTS.graceMin`), so a resume within it finds both and after it neither. 2 min for a worker whose
work is over, 10 min past a check-in and 10 min for an orphan: guesses, wide against what they guard (a check-in resumes its
worker within a minute or two; the portal stops a worker whose requests are closed at its next 5-minute pass). They are
`LEFTOVER` in `machine/leftovers.ts`. The pending check-ins come from the portal with the resumable sessions
(`resumable`/`welcome` `wakes`, no protocol bump: an older daemon ignores them).

**A worker's own teardown.** `ff-leftovers list` and `ff-leftovers end` (written beside `unity-slot`, first on agents' PATH)
list and end what the caller's own session started that still runs, never its own chain, the agent process, claude's MCP
servers or an interactive editor. Every worker's brief (`PROCESS_HYGIENE`) asks for it before DONE, with a quit timer on every
player. The agent process is found two ways (w1222): up the parent chain from the command, and from the environment, as the
session's root (a process carrying the session whose live parent, its agent host, does not). The chain alone failed on
Windows: Git Bash's fork+exec leaves each MSYS program a Windows parent that has already exited, so on 2026-10-13 the walk
stopped at the shim's `sh.exe` and four workers' `ff-leftovers end` killed their own claude.exe (exit code 1). The `sh`
shim also hands node the Windows pids of its MSYS parents (`/proc/<pid>/winpid`, in `FF_LEFTOVERS_CALLERS`), so the shell
that runs it is spared too; a Mac and Linux keep an intact chain (`exec` replaces the process) and set nothing.

Tests: `server/leftovers.test.ts` (biscuit's two players and their Xvfb end; a waited-for worker's, a gnome session's and a
batch build's leftovers end; the orphan ends; a live worker's player, a check-in's run, an interactive editor, the main
clone, another machine's process and anything before the welcome stay; a busy compiler server stays; real processes on
Linux; `readEnvs` on the machine it runs on, Windows included; BEAST's measured process tree of a worker's own
`ff-leftovers end`, and the real shim run from a bash pipeline under a stand-in agent, which must survive it), `machines.test.ts` (the daemon hears the check-ins).

### A clean-up worker's deletes are judged by the ledger (w1379)

2026-10-15: w1374, LothDesktop's low-disk clean-up (worker d314b54b, `V:\ffw`), deleted the temp folder of stopped worker
a735f37c. That worker is on w1332 (the comet catch-tail VFX), which the ledger had stalled at 13:15 on a usage limit and which
then waited for Ben's OK of the look; it lost its player builds and preview clips and had to rebuild (the look itself was
committed). **Probably not the daemon, not proven**: the machine's daemon (commit 38f8812, which has w1097) leaves a session a
request still waits for (`server/resumable.ts`, stalled counts as open), and the portal's clean-up log for that day (`portal_logs`
source `cleanup`, machine `lothdesktop`) has no entry naming a735f37c; the session sweep logs only to the daemon's own log
(`~/.ff-factory/logs/daemon.log` on the machine), which the portal does not keep, and the worker's transcript was not read. What
the ledger shows is the brief the clean-up worker got: it named five live workers and "39b00201 and d4c4ff2c are stopped but will
resume", written out by hand, and told it to remove "stopped agents' temp and clone folders"; a735f37c was on neither list, and a
worker cannot read other requests from the ledger (`read_work` shows its own). One daemon gap did exist and is closed below.

**Now the machine tells the worker.** The portal sends each daemon, with `resumable`, an `owners` map (`ownersOf`,
`server/resumable.ts`): every session of the machine with at least one request that is not closed (open, queued, blocked,
stalled; a pause is a blocked request), each with all its requests, their status and whether the session is the one the request
is with now. The daemon (`machine/daemon.ts` `cleanupFacts`, every 30 s and on every portal message) writes it, with its live
sessions, the sandboxes and the ledger's open and closed request ids, to `<daemon folder>/cleanup-facts.json`. Two commands on
every worker's PATH read it (`machine/leftovers.ts`, beside `ff-leftovers list/end`; the shim sets `FF_CLEANUP_FACTS`):

- `ff-leftovers folders`: every folder a clean-up could take under the install folder (`tmp/ffa-<session>`, `scratch/*`, each
  sandbox's `Builds/*` and `.nightly-builds/*`), each `KEEP` or `DELETE` with its owner and why, deletable ones measured.
- `ff-leftovers check <path>...`: the same verdict for paths about to be deleted; exit 1 if any is to be kept.

**Verdicts** (`server/cleanupFolders.ts`): a session's folder is kept while its worker runs, and while any request that is not
closed names the session (also one the request has moved on from: the daemon's sweep takes those after the grace of w1097, a hand
delete does not); it is deletable when no open, stalled or paused request names it: its requests are closed (done, merged,
rejected, cancelled), or it belongs to no request at all (an orphan). A `scratch/` folder or any folder named for requests
(`w1332-comet-catch-tail`, a review folder) is kept while one of them is open, deletable when every one is closed, and kept when
one is in neither list or none is named ("cannot be attributed": listed for a person). A sandbox's build and capture output is
kept while a worker in it runs or is on a request not closed. **Whatever is not provable is kept**: facts older than 5 min
(the daemon is not writing), a daemon not connected to the portal, a portal that sends no `owners` (before w1379), a machine
with no worker install folder, a path outside it (w896). The answer says why, so the worker reports what it skipped.

**And git keeps a folder whatever the ledger says** (w1387). The same evening w1385, LothDesktop's next low-disk clean-up, deleted
`tmp/ffa-31ffe8cc` (538 MB, the nightly merge review w1367's clone `ff`) and `tmp/ffa-28ebd585` (45 MB, w1258's worktree
`wt-w1258-claims-gather-parallel`) on DELETE rows: their requests were closed. The portal's own clean-up had kept both for hours,
"kept for a person: holds a git repo with uncommitted or unpushed work" (its log, source `cleanup`, 21:11Z to 22:11Z; 28ebd585
since 2026-10-14 05:40Z), and the uncommitted files could not be recovered. Now a row the ledger frees is checked as the sweeps
check a clone (`server/cleanup.ts` `localWorkWhy`, which `hasLocalWork` and every sweep use): a git repo in the folder, up to
three levels below it, or around it (a `check` of a path inside a clone, unless git ignores that path: a sandbox's `Builds/`)
with uncommitted changes, commits on no remote or a stash makes it `KEEP`, naming the repo and what it holds, with the ledger's
own verdict beside it. A stash counts in the sweeps too since w1387; a linked worktree's stashes are its main clone's, so they
keep the main clone only. Tests: `server/cleanupFolders.test.ts` (w1387).

**The rule for people writing briefs**: a clean-up brief never carries a list of live or "will resume" workers; it says to run
`ff-leftovers folders` and delete only the DELETE rows (`server/agents.ts`: `DISK_HYGIENE`, the dispatcher's and the orchestrators'
low-disk rules). The ff-agents lesson `clean-up-after-yourself` and the delete checklist say the same.

**The daemon's own sweeps wait for the welcome too.** `resumable` is empty until the portal's welcome has come since the daemon
started, so a stopped worker a request waits for looked finished: a daemon restarted while the portal was down could sweep its
folder. Now the session sweep does nothing until then (`SweeperDeps.ready`, `server/sessionSweep.ts`) and the clean-up guard
keeps the whole agent temp root (`cleanupGuard` in `machine/daemon.ts`); a daemon that never hears a portal sweeps no worker folder.
Tests: `server/sessionSweep.test.ts` (w1379), `server/machines.test.ts`.

Not covered: the portal host's own review folder (`/srv/fff/review/<topic>`) is outside any worker root and no daemon sweep
takes it; a hand delete there still goes by the request id in the topic name (`ff-leftovers check` judges any path whose name
carries one, but only inside an install folder). Needs a portal deploy (the `owners` field) and the daemon update that follows
it; until a machine's daemon is updated the commands answer "no ledger facts" and nothing is deletable.
Tests: `server/cleanupFolders.test.ts` (a stopped worker on a stalled request kept, a worker on a closed request and an orphan
deleted, scratch and sandbox output, every untrusted-facts case, the command's exit codes, the shim), `server/machines.test.ts`
(the daemon's facts follow a request from stalled to done), `server/evidenceRules.test.ts` (the briefs).

### Routine test steps without a prompt (w1097)

Lothsahn (2026-10-12): "I just got prompted to accept a bash prompt in w1079. Why did it do that, and how do we allow it to
do what it just needed to do without a complex bash prompt?" Worker 35e02c31 (w1079, the resizable blueprint menu) sent one
multi-line Bash command: `D="/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory"; rm -rf $TMPDIR/f1920
$TMPDIR/f1280`, a shell function `run()` that restored a backed-up `settings.json` into the game's data folder in a `cp`
retry loop and ran its test-leg script, then a grep of PanelPosition and PanelSize (the ledger keeps its first 120
characters; the rest is from the request's brief).

**Where prompts come from.** Workers run in `bypassPermissions` (`config.ts` `worker.permissionMode`). The guard
(`server/guard.ts`) is a PreToolUse hook that only ever answers `deny` (`guard.ts:89`, the one `permissionDecision` it
returns), never `ask`, so it cannot raise a prompt. The prompt is Claude Code's: in bypass mode the CLI still calls
`canUseTool` for the checks its own table marks `bypassImmune` (Claude Code 2.1.284, the binary in
`@anthropic-ai/claude-agent-sdk-win32-x64` 0.3.284: `dangerousRemoval`, `isolatePeerMachines`, `restrictedMode`,
`outsideReadsBlocked`); for a worker's Bash command that is the dangerous-rm check. `canUseTool` lands in
`Session.askPermission` (`server/sessions.ts`), which answers the w913 temp delete itself and asks a person for the rest.
The SDK's warning "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call" (seen
in the portal journal, 2026-10-12) is not the whole story.

**Measured** (2026-10-12, lothdesktop: a Messages API stand-in on 127.0.0.1 that returns one Bash `tool_use` with the
exact command, a real SDK `query()` in bypass mode with a `canUseTool` that records `decisionReason` and refuses; no
model, no spend; the targets did not exist):

| Command | Asks? | Claude Code's reason |
|---|---|---|
| the w1079 command rebuilt as described, `rm -rf $TMPDIR/f1920 $TMPDIR/f1280` in it | no | — |
| a shell function, a `for`/`until` retry loop, several lines, `&&`, a pipe, a heredoc, `$(...)` | no | — |
| `cp` into `.../LocalLow/Never Games/finalfactory/...` | no | — |
| `bash "$TMPDIR/leg.sh" 1920`, `python scripts/game_data.py run ... -- ...` | no | — |
| `rm -rf $TMPDIR/{f1920,f1280}`, `rm -f $TMPDIR/*.log`, w901's `rm -rf ... $TMPDIR/*.log ... /tmp/ffb-w901` | **yes** | `Dangerous rm operation on possibly-empty variable path: $TMPDIR/{f1920,f1280} in ...` |
| `rm -rf /ffa-x`, `rm -rf "C:/ffa-x"` | **yes** | `Dangerous rm operation on critical path: ...` |

So of the parts w1097 named (the `rm -rf`, the function, the write into LocalLow, the compound form) only an `rm` can raise
it, and only in a form the check flags. The command as described does not ask on its own; the part the ledger cut off
must hold a flagged `rm` (a glob or a brace list after `$TMPDIR`, or a critical path). The session did not answer it
because the w913 rule (`tempOnlyDelete`) took only a command made of deletes alone, and this one also copied, looped and
ran a script. The transcript event did not keep Claude Code's reason, so the exact `rm` cannot be read back; from w1097
on it is kept (below).

**Why the worker deleted at all** (lothsahn, 2026-10-12: "For w1097 why are workers deleting stuff in temp? Can't we have
the cleanup process when a worker is done do this for them so the worker doesn't have to worry about it?"). To rerun a test
leg into the same folder. w1079's tour script (`specs/w1079-blueprint-resize/run_tour.sh` in its PR, FinalFactory #1536)
takes an output folder per screen size and writes the leg's stills there, and the PR says "the evidence was re-run until
both legs agreed"; the deleted folders, `$TMPDIR/f1920` and `$TMPDIR/f1280`, are those two (sourced from the PR and the
ledger's copy of the command; the transcript is on beast). The brief said "do not clean up after yourself", and a rerun's
reset did not read as clean-up. The brief, the evidence-gate delete checklist (item 0) and its two lessons now say: never
delete in your temp folder, mid-task included; every leg writes to a new `$TMPDIR/<leg>-<timestamp>`, and the daemon
removes the whole folder when the session ends.

**The end-of-session sweep runs (measured, lothdesktop, 2026-10-12).** Session b3327616 (this request's worker) was
stopped at about 06:52 UTC; at 08:05 its folder `V:\ffw\tmp\ffa-b3327616` held only its four git clones (kept six hours) and
what the resumed process made: the scratch from before (a 45 MB `cli.txt`, `probe/`, the probe scripts and their outputs)
was gone. The portal's clean-up log for lothdesktop (`portal_logs` source `cleanup`) lists whole finished sessions'
folders removed, e.g. `ffa-dd8193f8` 5.3 GB at 08:06:45 UTC and `ffa-476c7481` 3.8 GB at 04:59 UTC; neither is in
`V:\ffw\tmp` now.

**But it also ran on a pause, which it must not (fixed).** b3327616 was not done at 06:52: it was stopped for LothDesktop's
V: grow with w1097 still open, and lost its scratch anyway. So did dcf976fc (w1086, belt corners, lothdesktop/slot4): its
"before" clips and a player build in progress, which it had to record and build again (its report, relayed by lothsahn's
orchestrator). Nothing for either is in the portal's clean-up log (`portal_logs` source `cleanup`, lothdesktop, from
2026-10-12T00:00Z): the remover was the session sweep, which logs only to the daemon's own log. The code says why:
`SessionSweeper.tick` (`server/sessionSweep.ts`) started its 10-minute clock at the end of the process, so a wait for CI or a
person, a stop or a pause emptied the folder of a worker that came back to it; the daily pass's `stopped-session-temp` rule
(`server/installLeftovers.ts`, untouched for 2 h) and the `agent-temp` rule (`server/cleanup.ts`, 2 h) did the same to a
longer wait, a Unity CI run included. "Keep everything in temp and let the harness remove it" only holds if temp survives a
pause, so:

- The portal works out which of a machine's sessions a request still waits for (`resumableSessions`, `server/resumable.ts`:
  a worker on an open or stalled request that is still with it, AgentManager.workOver's rule turned round) and tells the
  daemon in the `welcome` and in a `resumable` message whenever the set changes (each 20 s heartbeat compares,
  `MachineManager.pushResumable`). No protocol bump: an older daemon ignores both and sweeps as before; an older portal
  sends neither.
- The daemon keeps those folders in its clean-up guard (`CleanupGuard.resumable`, `neverDelete`: "a stopped session's
  folder that its open request will resume"), which the daily pass's two rules go through, and the sweeper treats such a
  session like a live one: its 10 minutes start when its request closes or moves to another worker.
- Tests: `server/resumable.test.ts` (the rule; the guard; a session stopped for three hours on a waiting request keeps its
  folder, which goes 10 minutes after the request closes; the daily pass leaves it), `server/machines.test.ts` (a real
  daemon is told in its welcome, and told again when the request closes), `server/machineProtocol.test.ts` (the decision).

**What changed**

| What | Where |
|---|---|
| A delete inside a longer command is answered by the session when Claude Code's reason is its dangerous-rm check, the session runs in bypass mode, and every delete in the text is one `tempOnlyDelete` allows (every `rm`/`Remove-Item` word must be a statement it judged; no `TMPDIR`/`PATH` reassignment, link, `eval`, `xargs`, nested shell, `find -delete`, or function named `rm` in the command) | `tempDeletesWithin`, `server/tempDelete.ts`; `ownTempDelete`, `server/sessions.ts` |
| `$TMPDIR/$S` (a variable after the folder) is no longer accepted: empty, it is the folder itself | `insideTmp`, `server/tempDelete.ts` |
| The save-copy rule knows the game's `UserData/saves` (`GameDataPaths.Saves`, since 2026-10-11) | `SAVES_DIR`, `server/tempDelete.ts`; the saves line of the brief and `docs/attachments.md` |
| Claude Code's reason is kept on the permission event and shown on the card | `reason` on `permission` events (`shared/types.ts`), `server/sessions.ts`, `web/src/components/Transcript.tsx` |
| The prompt count groups every prompt by kind: Claude Code's reason when kept, the command's shape before | `promptKind`, `byKind`, `scripts/cleanup-approvals.ts` |
| Every worker's brief: a new folder per run; multi-step logic in a script file in `$TMPDIR`; the game's settings and saves through `scripts/game_data.py` | `DISK_HYGIENE`, `SHELL_STEPS`, `server/agents.ts` |
| `scripts/game_data.py` (game repo): `snapshot`, `restore`, `run -- <command>` (restores whatever the command did, keeps `after/`), `get <key> --after`, `put`; writes only `UserData/settings/settings.json`, `LocalSettings/settings.json` and the saves named; retries a file the game holds | game repo, `scripts/tests/test_game_data.py` |

**Unchanged on purpose**: a delete outside the install folder is still refused by the guard (`rootFence.ts`); anything the
session cannot judge still asks a person; writes into the game's data folder were never asked about in bypass mode, and
nothing here widens them (the new tool writes only the settings files and the named saves).

**Tests**: `server/tempDelete.test.ts` (w1079-shaped legs answered, 30 escapes refused, the `UserData/saves` copy),
`server/agentSession.test.ts` (answered in bypass mode with the dangerous-rm reason; another reason, a delete outside, or
default mode asks, and the card and transcript carry the reason), `scripts/cleanup-approvals.test.ts` (kinds),
`server/evidenceRules.test.ts` (the brief). **Measuring**: `node scripts/cleanup-approvals.ts <dataDir> --since <7 days
back> --split <deploy date>` ends with every prompt by kind, before and after.

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
no other reason to delete outside its folder; the one it does have, the save copy it put in the game's saves folder, is
allowed: one entry named after its own temp folder (`ffa-<session>-<name>`, the tag read from its shell's TMPDIR), never
`saves/*`, another session's copy, a person's save or a path written with `..`, in the saves folder of Windows
(`AppData/LocalLow`), Linux (`~/.config/unity3d`) or macOS (`Library/Application Support`). Its words are read as the shell
reads them: `~/.config/unity3d/"Never Games"/...` and `Never\ Games` are one path (w1505: worker c1687d63 was refused its own
copy twice because the fence cut the path at the space); an unquoted space is two paths, so that form stays refused.

**What a clean-up worker reports for what is outside the root**, each with a size (`du`, `Get-ChildItem | Measure-Object`):
Unity Hub's editors and installers; `%LOCALAPPDATA%\Unity` (logs, package cache, licences); `LocalLow\Unity\Caches\GiCache`;
`LocalLow\Never Games\finalfactory` (saves, `DeterminismAudit`, `AgentControl`, `TestResults.xml`, `PlaytestSessions`);
`~/.claude` (transcripts, plugins); dotnet workload temp; the system temp; the npm, NuGet, pip, uv and Playwright caches;
Windows crash dumps. For each: which setting or script makes FF Factory write there, and whether a variable could move it
inside the root (candidates, not verified here: `NUGET_PACKAGES`, `npm_config_cache`, `PLAYWRIGHT_BROWSERS_PATH`,
`DOTNET_CLI_HOME`, `UV_CACHE_DIR`, `PIP_CACHE_DIR`, `CLAUDE_CONFIG_DIR`; Unity's own folders have none and the game's data
folder has no override, [worker-root.md](worker-root.md) section 2). Moving one is a request for lothsahn to decide, not
clean-up work.

### Sandbox Library caches: trim on release (w898)

Lothsahn (2026-10-10): "almost all the space is in the work folder, specifically in the BuildCache and BurstCache folders of
the various sandboxes", then: "I would like the harness to trim the burst cache and build cache when a worker releases a
slot. The worker should not have to do this--it should be built into the code", and "Slots should have a new state called
'cleanup' and the dispatcher should not allocate workers to cleanup. Once the trim finishes, the slot should go idle".

**Measured (lothdesktop, 2026-10-10).** `Library/BuildCache` 6.2-12.7 GB and `Library/BurstCache` 4.8-6.7 GB in each of the six
sandboxes (87 GB; a fresh seed holds 0.7 and 2.5). Unity never removes entries, so every code change adds some. NTFS keeps
last-access times (`disablelastaccess` 2) but a build reads the whole BuildCache, so only write times tell old from current:
about half of each cache was written more than 2 days before. One commit's working set is small: after a build from
nothing, BuildCache is 0.4 GB and BurstCache 3.2 GB. Player build of one commit in slot6 (`scripts/nightly/build_player.sh`,
Burst SSE2+SSE4, no other build running): fully warm 112 s; with every file older than a day pruned (6.3 GB) 106 s; both caches
removed (the rest of `Library` warm) 530 s, 5 times longer. A wipe costs that on the next worker's first build; a trim does not.

**The trim** (`server/cacheTrim.ts`, `TRIM_DEFAULTS`: keep files written within 24 h, then each cache cut oldest-first to 4 GB, give up
after 10 min; the numbers are a guess on top of the measurements above, kept above one commit's working set): removes cache
*files*, never a whole cache folder and nothing else under `Library`. **When**: `SandboxPool.trimReleased`
(`machine/sandboxes.ts`) watches each sandbox's live agents (the daemon's own sessions, `liveIn`) at every 30 s look and trims the
moment the last one is gone, whichever way the worker left (request closed, a wait for CI or a person, a stop, the idle
reaper): the portal needs no new message. **State**: the sandbox is `cleanup` (`SandboxStatus`) from that moment: not free
(`Agents.free`, the capacity count and placement all need `ready`), refused by `startWorker`, by the daemon's start check and by
editor starts and branch switches, shown as `cleanup` in `list_sandboxes` and "Cleanup" on the dashboard; it is `ready` again
when the trim ends. **Safety**: never with an agent live there, a pool editor up, or `Temp/UnityLockfile` present (an editor or a
batchmode build); a release with the editor up waits (`pendingTrim`) and trims after the editor stops; a trim stops between
two files when a lock file appears. **Failure**: a hung, failing or slow trim is cut off after `timeoutMs`, the sandbox goes
back to `ready` and the pool logs why (and tells the orchestrator when it stopped early); a daemon restart reads `cleanup` back
as `ready`. `daemon.json` `sandboxCacheTrim` sets the limits or `false` for never.

**Backstop** (`cleanupRules`, for sandboxes nobody releases): `sandbox-lib-cache-idle` (whole `BuildCache`/`BurstCache`, unused
for `libraryCacheIdleHours` 48), `sandbox-lib-cache-cap` (a cache over `libraryCacheCapGB` 6, idle an hour) and
`sandbox-lib-cache-low` (all idle ones, while free space is below the soft threshold), each only while the project has no
`Temp/UnityLockfile` and, as every rule, with the entry renamed first so one with an open file is skipped.

**Seeds.** A new sandbox's Library comes from the configured `librarySeed`, which keeps its caches (a warm start; lothdesktop's is
0.7 + 2.5 GB). When the seed is missing the copy falls back to the main clone's or a sandbox's Library, and now leaves their
`BuildCache` and `BurstCache` behind (`copyTree` `exclude`; robocopy `/XD`, elsewhere removed after the copy). D: on lothdesktop is NTFS,
so copies are full; a block-cloning volume (w900's Dev Drive) would make the six copies share blocks but not stop each from growing.

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
