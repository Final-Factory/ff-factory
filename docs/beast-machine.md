# The portal's own host as a machine (BEAST)

**TL;DR:** BEAST's sandboxes, editors and workers run under a machine daemon on BEAST itself, the same
`machine/daemon.ts` the M3, the M5 and LothDesktop run. The portal runs only the orchestrators and the dispatcher.
BEAST shows up as machine `beast` with its sandboxes named `beast/<name>` (bare names keep working). The move re-homed
the records only: folders, branches, Libraries and running editors stayed where they were. It was done on 2026-10-05
(w424, w440) with `migrate_host_sandboxes`, and that tool, its rollback and the portal's own sandbox code were deleted
on 2026-10-06 (w510): BEAST cannot go back to host sandboxes, by design (Lothsahn: "I expect we can never rollback BEAST,
and that's OK."). Backlog step 2 (portal restarts that leave the daemons' agents running) is on since 2026-10-05
(`machines.keepAgentsOnRestart`).

## What the portal does and what the daemon does

| In the portal | In the daemon (`beast`) |
|---|---|
| Orchestrators, the dispatcher, the ledger, intake, timers, the web UI, the machine manager | Sandbox worktrees in `F:\ffsb`: the pool (`machine/sandboxes.ts`, `SandboxPool`), as on LothDesktop |
| `RemoteSession`s for BEAST's workers | The workers' Claude processes, children of the daemon (a scheduled task), not of the portal: a portal restart does not stop them |
| Placement across machines (`server/placement.ts`) | The machine's `max_sandboxes` / `max_unity` / `max_sandbox_agents` / `max_agents_per_sandbox` |
| Portal-side clean-up of this computer (below) | The editor watch (dialogs, hang, crash, idle stop): `MacUnityWatch` (Windows branch), the rule table `server/watchdog.ts decide`, its own idle stop (`unity.idleStopMinutes`) |
| Restarts and updates of the portal itself | The host guard for its drive, disks and the browser reaper (`machine/hostGuard.ts`, [self-recovery.md](self-recovery.md)) |

Before w510 the portal also ran its own pool for BEAST (`server/sandboxes.ts` `SandboxManager`), with host limits and a
host editor watch. All of that is gone; `server/sandboxes.ts` keeps only shared helpers (`slugify`, `branchProblem`,
`normalizePurpose`, `withBaseRepoLock`, `pickEditorLog`, `pruneEditorLogs`).

## Design

**One machine is local.** `add_machine {id: "beast", local: true}` marks the record `local` (`shared/types.ts
Machine.local`; at most one, Windows hosts only). A local machine:

- **Deploys without ssh.** The same PowerShell scripts as a Windows PC (`server/machineDeployWin.ts`) run through
  `powershell.exe` on this computer (`scriptCommand(LOCAL)`); the code bundle is written into the user's home instead
  of `scp` (`server/machineDeploy.ts localBundle`). `machine_daemon` and `remove_machine` use the same local route, and
  the offline redeploy does not wait for ssh (`MachineManager.watchOffline`). Its probe does not search the drives for
  a clone: the base clone is given (`probeSlug`). The first try on BEAST (2026-10-05) died in that search, on a repo
  without an `origin` (fixed in w424).
- **Starts only with its user signed in.** Its task, like `ffsb-server`, runs in the desktop session: after a reboot
  the daemon and its agents are back once the user signs in (BEAST signs in automatically).
- **Runs as the portal's user, non-elevated,** in its own `FFFactoryDaemon` scheduled task at logon (the same task XML,
  `LeastPrivilege`), so it survives portal restarts and never inherits the portal's process tree. If Windows refuses a
  non-elevated registration, the deploy writes `daemon-task.xml` into the daemon's folder and names the one
  administrator command that registers it; a task registered once keeps working for later deploys.
- **Takes some settings from the portal's config** (`localMachineDefaults`, `server/machines.ts`): main clone =
  `repo.basePath` (`C:\ffsb\_base`), `sandbox_root` = `sandboxRoot` (`F:\ffsb`), disk guard from
  `hostGuard.warnFreeGB`/`criticalFreeGB`, protected paths = `protectedPaths` + this app + its data, editors below
  normal priority (the live game wins), portal URL `http://127.0.0.1:<port>` (no Funnel round trip). The daemon's own
  extras (`localDaemonExtras`) come from `unity.mcpServer` (the MCP-for-Unity server its workers get),
  `unity.idleStopMinutes`, and `hostGuard`, `hostDiskPaths` and `limits.minFreeRamGB` for its guard. Anything given to
  `add_machine` wins.
- **Takes its limits and Library seed from `add_machine` only.** Before w510 they came from `limits.maxSandboxes` /
  `maxUnity` / `maxSessions` and `librarySeed` / `librarySeedCopy` / `librarySeedGB` in the portal's config; those keys
  are retired ([README](../README.md#configjson), "Retired config keys"). Pass `max_sandboxes`, `max_unity`,
  `max_sandbox_agents`, `max_agents_per_sandbox`, `library_seed` and `library_seed_copy` to `add_machine`; omitted on a
  redeploy they are kept, so BEAST's record keeps the limits it already has.
- **Has no main-clone agents.** Its main clone is the base the sandboxes are worktrees of; a worker there is refused.
- **Cleans nothing itself** (`cleanup_config` 0/0: `machines.cleanupFor`, `server/index.ts`). The portal's clean-up
  covers this computer, BEAST's own daemon's sandboxes included, so `machine_cleanup` refuses it
  (`MachineManager.cleanupNow`) and points to `host_recovery cleanup`. The portal counts the daemon's running agents'
  temp folders as in use (`hostCleanupGuard` in `server/index.ts`).
- **Is guarded by its own daemon.** A new agent or editor there waits on the guard's reason (drive offline, disk low,
  RAM), and the Dev Drive recovery brings its editors and agents back, all inside the daemon (`machine/hostGuard.ts`).
  The portal has no gate on it any more (`MachineManager.localGate` is gone).
- **Is attributed to the host's login.** Its sessions keep `host:login`, and its daemon's own usage report is ignored
  (the portal polls that login already). Its workers' account is `claudeAccounts.workers`, unless
  `machines.useHostClaudeEnv` names the machine (`server/secrets.ts usesHostClaudeEnv`).

**Protocol 6** (`server/machineProtocol.ts`): the `adopt` and `release` sandbox ops take an existing worktree into the
pool, or drop it from the pool, without touching it (`SandboxPool.adopt` checks it is a direct child of the root named
after the sandbox and a worktree of the main clone; the branch is read from git). The daemon still answers both
(`machine/daemon.ts`), but nothing in the portal sends them since w510: the migration was their only caller. The pool
settings carry `maxAgents` (a total across sandboxes), `librarySeed`/`librarySeedCopy`/`librarySeedGB`, `belowNormal`
and `protectedPaths` (clean-up keeps them; a sandbox may not be named after one, as its Unity instance name would
collide).

**Routing.** `Agents.target` resolves a bare name to the local machine's sandbox, so `mp-r2` and `beast/mp-r2` are the
same everywhere (tools, the ledger, the dispatcher). `create_sandbox` and the New sandbox form default to the local
machine (`defaultSandboxMachine`). Standing agents' auto-delegation picks free `beast/<name>` sandboxes too.
`list_sandboxes` shows BEAST's sandboxes under `## beast (this host's own daemon…)`; the portal has no group of its own.

**The guard** of a BEAST sandbox agent is the machine sandbox guard plus the protected paths (the live game, this app
and its data). Ending or changing the daemon's scheduled task is refused for every agent (`server/guard.ts`), and the
reaper never touches a daemon (`server/reaper.ts isProtected`).

**The UI.** The host's group in the sidebar and on the Overview lists the daemon's sandboxes as its own; the daemon has
no group of its own, and a host without a local machine shows "orchestrators only" (`capacityLine`, `shared/fleet.ts`).
The group's dot turns red with "daemon offline" while it is down, and the Overview card opens the daemon's machine page
(redeploy, restart, its log folder). A sandbox's page is the machine sandbox page (`#/machine/beast/sandbox/<id>`); an old
`#/sandbox/<id>` link opens this host's own daemon's sandbox of that name.

## How it was moved (2026-10-05, w424)

The move was in place, with no loss: per sandbox the portal's record, its agents' records and the delegations naming it
went from the host's lists to `machines[beast]`, and the daemon adopted the worktree (`adopt`); a running editor was
found by its command line at the daemon's next look and kept running. All five sandboxes moved in one call at 19:31 UTC,
7391 agent records, and each sandbox's branch, HEAD, uncommitted files and Library were the same afterwards.

- **Before:** two hard-reset risks found before the move were fixed first (#100, crash-safe migration and daemon
  `sandboxes.json`), and the probe that failed on a repo without an origin (#99).
- **Deploy:** 3648774, then `add_machine beast local`. Its first try was on a portal started from an elevated ssh
  shell with nobody signed in; the elevation fix is in #99 and auto sign-in on BEAST.
- **Fixed after:** the outside watchdog, which had started watching the local machine's loopback (#106).
- **Crash safety that stayed:** the daemon's `sandboxes.json` is fsynced before the rename that makes it current, with
  the last good versions kept beside it, and a file a reset damaged loads from the newest good version
  (`server/durable.ts`; since w424, because it could come back empty and make the portal forget the machine's
  sandboxes). BEAST hard-resets on WHEA errors.

## Rollback

There is no rollback to host sandboxes. `migrate_host_sandboxes` (to the machine and `back`), `server/hostMigration.ts`
and the offline `scripts/host-migration.ts back` were deleted with the portal's own pool (w510). A portal older than the
`local` machine would try to redeploy `beast` over ssh and refuse new agents on its protocol-6 daemon, so rolling the
code back past it is not an option either.

What still rolls back is the move of the portal itself, below.

## Backlog step 2 (on)

On since 2026-10-05 (w424). It was tested on BEAST before being turned on: restart B, 22:45:33 UTC, with the portal
down 84 s. A test worker mid-turn on `beast/shader-blackhole` and one on `lothdesktop/ghosts-fly` went on through the
downtime; BEAST's daemon and its five agent processes kept their pids; the events from the downtime were replayed into
their transcripts; nine agents were reported "Still running there (not interrupted)". Details in
[restart.md](restart.md), "Agents on machines". Restore `config.json.prev-w424` and restart to turn it off.

`machines.keepAgentsOnRestart: true` (config.json; not in `set_app_config`'s allowlist on purpose): a portal restart or
update no longer asks daemon-hosted workers to wrap up (`Drainer` snapshot) and no longer stops them (`stopServer` →
`sessions.stopAll` skips `RemoteSession`s). A daemon from another commit that speaks the portal's protocol still takes
new agents (`MachineManager.incompatible`) and is redeployed once idle; after the restart, workers still running are
reported as "Still running there (not interrupted)" and the rest are resumed as today. The daemons already queue events
while the portal is down (up to 20 000) and replay them on reconnect.

## When the portal leaves BEAST

The portal is moving to a VM on the FFBox host ([portal-on-ffbox-host.md](portal-on-ffbox-host.md)). BEAST stays the
same machine with the same sandboxes:

- `relocate_machines` points its daemon (and the others) at the new URL.
- `convert_machine beast to: "ssh"` makes its record an ssh machine. It keeps its id, token, sandboxes and agents.
- `fffctl migrate` (w499) does both at the cut-over, from the VM.
- Rolling back is the same two calls the other way: relocate to `http://127.0.0.1:<port>`, then convert to `"local"`.
  This works because the daemon never stopped being BEAST's; it needs no host sandboxes.

Details in [machines.md](machines.md), "Moving the portal".

## BEAST-specific things left in place

- The portal's host guard measures its data volume and `hostDiskPaths`, and its clean-up still covers this computer,
  BEAST's own daemon's sandboxes included (`hostStalePlaces` in `server/index.ts`). The Dev Drive remount helpers
  (`scripts/install-privileged-helpers.ps1`, `ffsb-helper-mount`) are used by the daemon's guard, not by the portal.
- Standing agents no longer run on BEAST through the portal. A standing agent needs a machine, and one with no machine
  does not run ([standing-agents.md](standing-agents.md)).
- The game repo's nightly scripts address BEAST by ssh and path, unaffected by this change (no folder moves):
  `scripts/nightly/lab.m3.json` (client B `root: F:/ffsb/nightly-e2e/Builds/nightly`, a folder outside the pool),
  `nightly.sh` and `beast_watchdog.sh` (`F:/ffsb/_nightly-e2e/reports`), `install_schedule.sh` (the watchdog task over
  ssh), and `player_slots.py` / `setup_player_slot_firewall.ps1` (BEAST picks `F:\ff-players` because `F:\ffsb` exists).
- Agents on machines have no `wait_for_unity` tool (they poll `unity status`), as on LothDesktop.

## Known limits

- While the Dev Drive is gone, the daemon's editor watch finds its sandbox editors crashed and gives up after its
  restart budget; once the daemon's guard has reattached the drive it starts those editors again. The portal no longer
  has a remount of its own: `host_recovery` takes only `cleanup`, and `machine_daemon restart` makes the daemon's guard
  try the mount again. The recovery self-test (`host_recovery selftest`) was removed with it.
- After an unclean portal stop, the portal waits up to 15 minutes for the local machine's sandbox drive before it
  resumes that machine's agents (`Agents.sandboxRootBack`).
