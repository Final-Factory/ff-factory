# Self-recovery: disk space, the sandbox drive, memory

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

Each writes `%ProgramData%\ffsb-helpers\results\<action>.json` (`ok`, `at`, `detail`). The app
starts one with `schtasks /run /tn ffsb-helper-<action>` and waits for that file
(`server/privileged.ts`).

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

**After a reboot or a power cut.** A VHDX attachment does not survive either. `ffsb-helper-mount` attaches it at boot; the supervisor (`scripts/supervise.ps1`) also starts that task when the drive is missing, and waits up to 5 minutes for it before starting the server; the server's host guard retries after that. The boot trigger is registered by `install-privileged-helpers.ps1`, so re-run it once (as administrator) after updating to get it.

**Reboot and automatic logon.** Unity editors need the interactive desktop (GPU), and the app
starts at logon (the `ffsb-server` task). After a reboot without automatic logon nothing comes back
until someone logs in, so the helper refuses. To allow reboots as a last resort, set up automatic
logon with Sysinternals Autologon, which stores the password as an LSA secret, not in plain text.
Prefer to leave it off and fix what makes reboots necessary.

## 2. The host guard (`server/hostHealth.ts`)

Every `hostGuard.pollSeconds` (30) it measures the sandbox root's volume and each of
`hostDiskPaths` (put `"C:/"` there when the Dev Drive's VHDX lives on C:), free RAM, and whether the
sandbox root exists.

**Disk levels**, with `hysteresisGB` (10) before a level clears:

| Level | When (any watched volume) | What happens |
|---|---|---|
| warn | below `warnFreeGB` (80) | a `[host]` message to the orchestrator and a push (kind "Host health"); new editors and new agent processes on this host are refused with the reason; standing runs wait |
| critical | below `criticalFreeGB` (40) | also: busy agents get "commit and push now, end your turn" once per episode; editors nobody is working in are stopped; a clean-up pass with every rule runs (at most every 10 minutes) |

**The sandbox drive.** When the sandbox root disappears:
1. The guard remembers the editors that were up and the agents mid-turn in sandboxes (from its
   last look), stops those turns, and reports.
2. It starts `ffsb-helper-mount`. If the volume holding the VHDX has less than `remountMinFreeGB`
   (30) free, it runs the clean-up and waits for space first.
3. Failed attempts retry after 2, 5, 10 and 30 minutes; after 6 it reports and stops trying
   (host_recovery "remount" tries again).
4. When the drive is back, it restarts those editors one at a time and sends each interrupted
   agent a resume message (check git status, re-pin Unity, continue).

**Memory and editors.** A new editor needs `limits.minFreeRamGB` (10) free. An editor whose sandbox
has had no agent activity for `unity.idleStopMinutes` (120), and no agent mid-turn, is stopped.

**Clean-up** runs all the time, not only in an emergency: see [Continuous clean-up](#5-continuous-clean-up)
below. The critical level also starts a pass (at most every 10 minutes), and so does a sandbox drive that
waits for space before it can be reattached.

**The orphan headless-browser reaper** (`server/reaper.ts`). Scripts that drive a headless browser
(screenshots, Playwright checks) sometimes die or hang and leave it running. Agents may not end
browser or node processes by hand (the guard), so the server does it: once at startup, then every
`hostGuard.reapEveryMinutes` (15). It only matches automation browsers:
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

**The recovery self-test** (`host_recovery` "selftest"). With no editor up and no agent busy in a
sandbox, it detaches the sandbox drive through `ffsb-helper-detach`, lets the guard notice the missing
drive and reattach it through `ffsb-helper-mount` exactly as in a real outage, checks that every ready
sandbox's folder is back, and reports the timings (detach, noticed after, reattached after, total). Run
it after installing or changing the helpers.

The orchestrator can set `hostGuard.devDriveVhdx` and the clean-up settings (below) with
`set_app_config`, and act by hand with `host_recovery`
(remount, cleanup, trim, compact, reboot with `confirm_reboot`). `system_status` and the sidebar's
meters show the guard: one disk meter per watched volume in its guard colour, and a banner while
the drive is offline or disk space is low.

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
- **Hand freed space back**: `ffsb-helper-trim` (online), then **compact** by hand
  (`host_recovery` "compact"). Nothing detaches the drive automatically (since 2026-09-24; the old
  `hostGuard.compactWhenReclaimGB` idle policy is gone and the key is ignored). Compact and the
  self-test are refused while any editor is up or any agent on this host is busy
  (`HostHealthMonitor.detachRefusal`); the helper itself also refuses while a `Unity.exe` has a project
  on the drive. The drive is offline for the few minutes the compaction takes; the guard knows and
  does not treat that as an outage.
- **Cap the maximum size** to what C: can hold, keeping `warnFreeGB` in reserve. Today the VHDX may
  grow to 900 GB on a 1.8 TB disk shared with everything else. Lowering the maximum means shrinking
  the partition inside and then the virtual disk (`Resize-Partition`, then `Resize-VHD`; Hyper-V
  tools, administrator, drive offline). It is a planned maintenance step, not something the guard
  does.
- **Memory is disk too**: an automatically managed pagefile grows on C: under memory pressure,
  exactly when things are already tight. A fixed pagefile (`-PagefileGB`), fewer concurrent editors
  (`limits.maxUnity`, `limits.minFreeRamGB`) and stopping idle editors keep that growth away.

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
"...", "ntfyServer": "https://ntfy.sh", "enabled": true }`. Without `publicUrl` (and no `healthUrl`)
there is nothing to watch. The Macs get the watch with the daemon: they redeploy themselves when idle after
an update.

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
  measured are the home folder's, the temp folder's and (host) `hostDiskPaths`; the fullest one counts.
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
| sandbox builds (host) | `<sandboxRoot>/*/Builds/*` | 7 days |
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

**Never deleted**, whatever a rule says (`neverDelete`, checked again right before each removal):
a drive root, the home folder and its top-level folders; system folders (`C:\Windows`, `Program Files`,
`ProgramData`, `/Applications`, `/System`, `/Library`, …); the sandbox root and every sandbox (a Builds
folder's entries excepted), the standing agents' folder, the base clone, this app and its data, protected
paths, a machine's clone, daemon folder and Unity; anything that is or holds a git repo, unless the rule
says otherwise (pushed agent clones, runner checkouts, this app's test scratch); `.claude` (settings,
transcripts), `.ssh`, `.gnupg`, `.aws`, `.config`, keychains and names that look like secrets;
`ff-local-backups`; `~/torque`; anything named like lab or audit artifacts (`DeterminismAudit`,
`ff-audit-artifacts`, `lab`); Steam and Unity installs; `.vhdx`/`.vhd` files (the F: VHDX); and the temp
folders of agents running now. **In use**: besides the age walk, each entry is renamed before it is
deleted. On Windows a folder with a file open inside cannot be renamed, so an entry in use is skipped
whole instead of half removed; a removal that fails after the rename leaves `<name>.ffclean-<n>`, which
the next pass removes.

**Per-agent hygiene.** Every worker on this host and every agent on a machine gets its own temp folder,
`<temp>/ffa-<session>` (under the machine's `temp_dir` when it has one), as TMP, TEMP and TMPDIR. It goes
when the session is removed, and two hours after the session stopped otherwise. The worker and machine
briefs tell agents to put builds, recordings and screenshot sets there and to delete them once reported.

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

What clean-up cannot fix is reported, not removed: user data (OneDrive, Videos, Downloads), the audit
artifacts, and on BEAST the Dev Drive VHDX, which grows but never shrinks by itself (634 GB for 334 GB used
on 2026-09-28): compact it by hand (section 3).

