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
| `ffsb-helper-mount` | attach the VHDX if it is not attached, bring its disk online, give its data partition the drive letter, wait for it |
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
| critical | below `criticalFreeGB` (40) | also: busy agents get "commit and push now, end your turn" once per episode; editors nobody is working in are stopped; the clean-up runs (at most every 10 minutes) |

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

**The known-safe clean-up** (`server/cleanup.ts`, `hostGuard.cleanup`):
- scratch in the temp folder: headless-browser profiles (`edge-shot-*`, `edge-keys-*`) and the
  test suite's own folders, when untouched for `tempOlderThanHours` (1);
- agent temp clones (`fff-*`, `ffsb-*`) untouched for `cloneOlderThanDays` (3), only when every repo
  in them has no uncommitted changes and no commits that no remote has;
- rotated editor logs beyond the newest three per sandbox;
- `ageRules`: entries in a named folder older than N days, for example
  `[{"path": "C:/Users/<you>/AppData/LocalLow/<studio>/<game>/DeterminismAudit", "olderThanDays": 14}, {"path": "C:/Users/<you>/ff-worker", "olderThanDays": 7}]`.
  An age rule never covers a drive root, the home folder, the sandboxes, the base clone, this app,
  its data or a protected path.

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

The orchestrator can set `hostGuard.cleanup.ageRules`, `hostGuard.devDriveVhdx` and
`hostGuard.compactWhenReclaimGB` with `set_app_config`, and act by hand with `host_recovery`
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
- **Hand freed space back**: `ffsb-helper-trim` (online), then **compact** when idle.
  `hostGuard.compactWhenReclaimGB` (e.g. 60; 0 = never) lets the guard do it by itself, at most once
  a day, when no editor is up, no agent is busy, and the file holds at least that much more than the
  volume uses. The drive is offline for the few minutes the compaction takes; the guard knows and
  does not treat that as an outage.
- **Cap the maximum size** to what C: can hold, keeping `warnFreeGB` in reserve. Today the VHDX may
  grow to 900 GB on a 1.8 TB disk shared with everything else. Lowering the maximum means shrinking
  the partition inside and then the virtual disk (`Resize-Partition`, then `Resize-VHD`; Hyper-V
  tools, administrator, drive offline). It is a planned maintenance step, not something the guard
  does.
- **Memory is disk too**: an automatically managed pagefile grows on C: under memory pressure,
  exactly when things are already tight. A fixed pagefile (`-PagefileGB`), fewer concurrent editors
  (`limits.maxUnity`, `limits.minFreeRamGB`) and stopping idle editors keep that growth away.
