# One root folder per worker machine (w511)

> **Built:** w513 implemented this as [worker-install.md](worker-install.md) (install, uninstall, migration, fixed player
> slots). lothsahn's decisions of 2026-10-06 changed some of it: the root is any folder, there is no HOME override, and
> the game's data folder stays; that page lists them.

**TL;DR:** A worker machine's daemon and its agents today write to the 63 places listed in section 1, spread over the person's home
folder, two or three drives, `%ProgramData%` and the OS's own stores. This page lists them all (section 1), then
proposes one root per machine (`F:\ffw` on BEAST, `D:\work\ffw` on LothDesktop, `/Users/Shared/ffw` on the Macs) holding
the daemon, its own bare clone of the game repo, the sandboxes, the Library seed, the player slots, the nightly lab,
scratch, temp, Claude Code's config and the tools' config (section 2). Environment variables set once on the daemon
reach every worker, because a worker's environment is the daemon's plus overrides (`server/launch.ts:186`). What cannot
move (Unity Hub's editors and licences, the Dev Drive and its SYSTEM tasks, people's own clones, OS registrations) is
named in config and recorded in the root's manifest, so the uninstall removes exactly that list. Built players run
only from `<root>/players/slotK`. BEAST has firewall rules today for **163 different non-slot `finalfactory.exe`
paths** (measured), and section 2.5 lists every remaining launch outside a slot. Install, uninstall and upgrade are in
section 3, containment in section 4, per-machine migration with code changes sized S/M/L in section 5. The decisions
for lothsahn are at the end. w513 (one-command install, a nothing-left-behind uninstall, a copy-first migration)
implements this design.

Request: w511 (lothsahn, 2026-10-06). Related: w510 (the portal runs only the orchestrators and the dispatcher; worker
6db46872 is removing the portal's host code), w513 (the implementation), w424 (BEAST's daemon), w469 (Unity slots), w477
(no agents in main clones).

## What this rests on

- **Measured on BEAST** (this host, read-only, 2026-10-06): sizes with `du -sh`, volumes with `Get-Volume`/`Get-Disk`,
  scheduled tasks with `Get-ScheduledTask`, firewall rules with `Get-NetFirewallApplicationFilter`, a worker's
  environment (variable names only) from inside a BEAST worker, git sizes with `git count-objects -vH` and
  `git lfs ls-files -s`.
- **Not seen**: LothDesktop, the M3 and the M5. Their paths below come from the code's defaults, `docs/machines.md`,
  the game repo's scripts and what `list_machines` reported to the orchestrator. No sizes are given for them. The
  protected folders on BEAST (`C:\Users\rydin\.ff-factory`, `C:\ffsb\_base`, `C:\ff-sandboxes`) were not listed or
  sized, except `_base`'s git store, measured through a worktree's common git dir.
- **Code**: ff-factory at `67375c4` (main); the game repo at `f56d6f97d` (origin/develop); the ff-agents plugin 1.20.28.
  Every `file:line` below is from those.

## 1. Inventory

Columns: what the path is for; who creates it; whether it is per machine (M), per sandbox (S) or per agent session
(A); its size on BEAST (measured) where readable; whether it holds a secret; where the code names it. "Daemon" means
`machine/daemon.ts` and what it runs; "deploy" means the portal's `add_machine` (`server/machineDeploy.ts`,
`server/machineDeployWin.ts`).

### 1.1 The daemon's folder (`app_dir`)

Default `~/.ff-factory` (`machine/daemon.ts:123`, `server/machineDeployWin.ts:207`, `server/machineDeploy.ts:349`);
BEAST `C:\Users\rydin\.ff-factory`, LothDesktop `D:\work\.ff-factory` (its `app_dir`), the Macs `~/.ff-factory`.

| Path (under `app_dir`) | For | Created by | Scope | Secret | Code |
|---|---|---|---|---|---|
| `app/`, `app.new/`, `app.old/` | the daemon's code (a `git archive` of the portal) and the swap on redeploy | deploy | M | no | `server/machineDeploy.ts:334`, `machineDeployWin.ts` (deploy step 3, docs/machines.md) |
| `daemon.json` | portal URL, machine id, **machine token**, repo path, folder options, pool settings | deploy; the daemon patches it on relocate | M | **yes** (token) | `machine/daemon.ts:113` (written 0600), `:1229`; `server/machineDeploy.ts:416` |
| `run-daemon.ps1`, `daemon-task.xml` | Windows supervisor; task XML when registration needs an admin | deploy | M | no | `server/machineDeployWin.ts:436,470,476` |
| `logs/` (`daemon.log`, `daemon.err.log`, `supervisor.log`, their `.<UTC stamp>[.gz]` archives) | daemon output: 14 days, at least 20 archives, at most 200 MB (docs/machines.md "The daemon's logs") | daemon, supervisor | M | redacted | `machine/logRetention.ts`, `server/machineDeployWin.ts` `supervisorScript` |
| `sandboxes.json` | the sandbox pool across restarts | daemon | M | no | `machine/daemon.ts:241` |
| `cleanup.json`, `cleanup-log.jsonl`, `cleanup-state.json` | clean-up settings and log | daemon | M | no | `machine/daemon.ts:136,270`; `server/cleanup.ts:537-569` |
| `outside-watch.json` | the outside watchdog's ntfy topic | daemon | M | **yes** (the topic is the credential) | `machine/daemon.ts:960-969` |
| `public-identity.gitconfig` | no longer written or read (w3093: the identity rides `GIT_CONFIG_*` itself); an old one is harmless | daemon (`FF_APP_DIR`) | M | no | — |
| `unity-slots/` (+ its `unity-slot` shims, put first on workers' PATH) | the Unity slot mailbox (w469) | daemon | M | no | `machine/unitySlots.ts:23-24`, `machine/daemon.ts:440,713-720` |
| `unity-mcp/<place>/` | each place's own `UNITY_MCP_STATUS_DIR` | daemon | S | no | `machine/unityMcp.ts:16-17,62` |
| `agents/<id>/` | standing agents assigned to the machine (`NOTES.md`) | portal via daemon | M | no | `server/machineDeploy.ts:353`; docs/machines.md "Standing agents" |

### 1.2 Per-agent and per-place things outside `app_dir`

| Path | For | Created by | Scope | BEAST size | Secret | Code |
|---|---|---|---|---|---|---|
| `<temp_dir or os.tmpdir()>/ffa-<session>/` | each agent's `TMP`/`TEMP`/`TMPDIR`; removed 2 h after its session ends | daemon | A | `%TEMP%` 14 GB in all, 15 `ffa-*` folders | no | `server/cleanup.ts:781-792`, `machine/daemon.ts:126,880` |
| `$TMP/claude*/` | Claude Code's task output (subagent transcripts, background shells) | Claude Code | A | inside the above | no | cleaned by `server/cleanup.ts:184-185` |
| `~/.unity-mcp/` | where the MCP-for-Unity editor plugin writes its status files; the daemon copies each editor's into its place's folder | Unity (the plugin) | M | 23 KB | no | `machine/unityMcp.ts:75`; ff-agents `editor-ops/SKILL.md:110` |
| `~/.config/ff-factory/max-events.jsonl` | what agents did as Max (`FF_MAX_EVENTS`) | `ffdiscord` CLI | M | (in `~/.config`, 131 KB in all) | no | `server/maxEvents.ts:13`, `machine/daemon.ts:341,882` |
| `<sandbox>/Logs/sandbox-editor*.log` | each sandbox editor's own log (`-logFile`) | daemon | S | small | no | docs/machines.md "Editors" |
| `<sandbox>/Assets/__FFFactoryReimport/` | one-time reimport after a Library copy | daemon | S | tiny | no | `machine/scriptReimport.ts` |
| `<sandbox>/Inbox/` | attachments fetched for the agent | daemon | S | varies | user files | docs/attachments.md |

### 1.3 Sandboxes, seed and scratch

| Path today | For | Created by | Scope | BEAST size | Secret | Code |
|---|---|---|---|---|---|---|
| `sandbox_root`: `F:\ffsb` (BEAST), `D:\work\ffsb` (LothDesktop); none on the Macs | the pool: `<root>/<name>` worktrees of the main clone, each with its own `Library` | daemon (`SandboxPool`) | S | six sandboxes, 532 GB in all: 15, 61, 108, 110, 114 and 124 GB; Libraries 43 GB (`slot-5`), 81 GB (`agent-mcp`), 99 GB (`mp-r2`) | no | `machine/sandboxes.ts:162-172`; config `sandboxRoot` `server/config.ts:247`; `server/machines.ts:72-76,103` |
| `F:\ffsb\_seed\Library` | Library seed, block-cloned on the Dev Drive | portal config `librarySeed` | M | 65 GB | no | `machine/sandboxes.ts:107-117,383`; `server/machines.ts:83-85,112-113` |
| `F:\ffsb\_scratch`, `F:\ffsb-scratch`, `F:\tmp`, `F:\ffsb\_research`, `F:\ffsb\_w94` | long-lived scratch agents chose (builds, clones, captures) | workers | M | 141 GB, 13 GB, 553 MB, 83 MB, 670 MB | no | none in code: the brief's "scratch" convention |
| `F:\ffsb\_agents` | standing agents' folders on BEAST (portal-run today) | portal | M | 96 KB | no | `standingRoot`, `server/config.ts:249-252`; docs/standing-agents.md:22 |
| `F:\ffsb\_review` | `publish_review` media | portal | M | 6.0 GB | no | `server/review.ts:9,16`. **Not a worker path**: it stays with the portal (D9 in portal-on-ffbox-host.md, accepted 2026-10-05) |

### 1.4 Main clones and their backups

| Path | For | Created by | Scope | Size | Secret | Code |
|---|---|---|---|---|---|---|
| `C:\ffsb\_base` (BEAST), `~/nevergames/FinalFactory` (Macs) | `repoPath`: the base the sandboxes are worktrees of, and main-clone agents' folder | the person | M | git objects 1.3 GB and LFS store 8.4 GB measured on `_base` (14 worktree entries registered in it) | no | `machine/daemon.ts:48`; probe `server/machineDeploy.ts:110,319`, `machineDeployWin.ts:281-284` |
| `ff-local-backups/<time>/` beside the clone | the backup-before-discard rule for a person's uncommitted work | workers (guard-enforced) | M | not seen | no | `server/guard.ts:54-56,151,167-191`; `server/agents.ts:1523`; ff-agents `project-memory/memories/feedback-back-up-then-clear-bens-clone.md:21` |

### 1.5 Players, nightly lab and legacy labs

| Path | For | Created by | Scope | BEAST size | Secret | Code |
|---|---|---|---|---|---|---|
| player slot pool: `<root>/players` of the worker install folder (`FF_PLAYER_SLOT_ROOT`; the pools the machines kept outside the install folder are gone, 2026-10-10): `<root>/slotK/player/`, `slot.json`, `leases/`, `pool.lock` | fixed exe paths for the firewall (w350) | `player_slots.py`, the firewall script | M | 13 GB | no | `scripts/nightly/player_slots.py` `default_root()` (`<FF_WORKER_ROOT>/players`, else refuses); `setup_player_slot_firewall.ps1:29-46` |
| `%ProgramData%\FinalFactory\player-slots.json`, `~/.config/finalfactory/player-slots.json` | the recorded slot root and count | firewall script | M | tiny | no | `player_slots.py:54-58` |
| nightly lab `FF_NIGHTLY_ROOT`: `<root>/nightly` of the worker install folder (the labs outside it are gone, 2026-10-10): own clone, `builds/<sha>-*`, `runs/`, `logs/`, `reports/`, `tmp/` | the nightly e2e | nightly scripts | M | not on BEAST | no | `scripts/nightly/nightly.sh:17-18,23-34`; `install_schedule.sh:31,46-54`; `make_overlay.py:78`; ff-factory `server/staleOutput.ts` (roots from `FF_NIGHTLY_ROOT` and `nightlyRoots` only) |
| `F:\ffsb\_nightly-e2e` (`reports/`, `beast_watchdog.sh`) | BEAST's report drop and watchdog | `install_schedule.sh` over ssh | M | 109 KB | no | `install_schedule.sh:25-27`; `nightly.sh:25` |
| `F:/ffsb/nightly-e2e/Builds/nightly` | the M3 lab's remote Windows peer root | `lab.py` | M | absent now | no | `scripts/nightly/lab.m3.json:10` |
| `C:\Users\rydin\ff-worker\` | the legacy Windows lab of the honest co-op runs (`ahttp.py`, builds by commit, logs) | agents by hand | M | 11 GB | no | ff-agents `honest-coop-play/SKILL.md:107,111`, `editor-ops/references/codex-fleet.md:81`; game repo `.claude/settings.json:77` |
| `~/nevergames/ff-audit-artifacts/<NNN>-<date>/` (Macs) | paired-audit labs | agents | M | not seen | no | ff-agents `honest-coop-play/SKILL.md:65` |
| `C:\Users\rydin\actions-runner-finalfactory-mode2\` | the self-hosted GitHub runner (`finalfactory-mode2-windows`) on BEAST | a person | M | not sized | runner credentials | game repo `.github/workflows/determinism-mode2.yml:32` |

### 1.6 Claude Code, git, gh, ssh and other credentials

| Path | For | Created by | Scope | BEAST size | Secret | Code |
|---|---|---|---|---|---|---|
| `~/.claude/` (`projects/` = transcripts and memory, `plugins/`, `settings.json`) | Claude Code's config and history; `CLAUDE_CONFIG_DIR` is **unset** for BEAST workers today (measured) | Claude Code, `registerAgents.sh` | M | 3.8 GB (`projects` 3.7 GB, `plugins` 124 MB, 63 cached ff-agents versions) | **yes** (`.credentials.json` on Windows) | `server/usage.ts:195`; `server/secretGuard.ts:167-177` |
| `~/.claude.json` (+ `.backup`, `.tmp.*`) | per-project MCP servers (the daemon reads the UnityMCP entry from it) | Claude Code | M | small | no (but guarded) | `machine/unityMcp.ts:29-32` |
| `~/.claude-worker-token` (BEAST) | a token file (config `claudeTokenFile` until w1078, which retired the key and the "tokenfile" account; nothing reads the file now) | a person | M | tiny | **yes** | `server/config.ts:195`, `server/appConfig.ts:312-315` (as measured before w1078) |
| `~/final-factory-agents/` | a person's checkout of final-factory-agents (publish-skills edits it; `registerAgents.sh` ran from it). Claude Code installs from its own marketplace clone, `~/.claude/plugins/marketplaces/final-factory-agents`, not from here. FF Factory never touches it: its agent tools publish runs from `<root>/tools/final-factory-agents` (w1476, [worker-install.md](worker-install.md#the-agent-tools-w1476)) | a person | M | 3.8 MB | no | CLAUDE.md of the game repo; `server/agentTools.ts` |
| `~/.local/bin/` (`claude.exe`, the `unity` CLI shim) | Claude Code's native binary; the editor-ops fallback | installers | M | 236 MB | no | `server/machineDeployWin.ts:269,354`; ff-agents `editor-ops/references/recovery.md:193` |
| `~/.gitconfig` | user git config; on BEAST its GitHub credential helper is `gh auth git-credential` (measured) | a person | M | tiny | no | — |
| gh's token: Windows Credential Manager (BEAST: "keyring", measured), `~/.config/gh` on a Mac, `%APPDATA%\GitHub CLI` | GitHub API and git pushes | `gh auth login` | M | — | **yes** | `server/secretGuard.ts:173-176` |
| `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` | the commit identity (`user.name`, `user.email`) in every clone, per worker (w3093) | daemon | A | — | no | `server/publicGit.ts` `gitIdentityEnv` |
| `~/.ssh/` | keys for ssh peers (`beast`, `m3`) used by lab and audit scripts; the portal's deploy key on BEAST | a person | M | not read | **yes** | `scripts/nightly/lab.py:97-111`; `server/secretGuard.ts:170` |
| `C:\ProgramData\ssh\administrators_authorized_keys` | the portal's public key for deploys over ssh | the owner (admin) | M | — | no (public key) | docs/machines.md "Setting up a Windows PC" step 3 |
| `~/.config/ffdiscord/config.json` (or `FFDISCORD_HOME`) | the Discord bot token for posting as Max | a person | M | present on BEAST | **yes** | `scripts/nightly/nightly.sh:42-43` |
| `~/.config/ffbox/` (`config.json`, `secrets.env`, `githubrunners/secrets.env`) | FFBox config; Max is posted through FFBox for every machine (`post_as_max`, w901); this config is only for the ffdiscord CLI's reads | a person | M | present on BEAST | **yes** (`secrets.env`) | ff-agents `project-memory/memories/feedback-never-print-a-secret-file.md:8-22`, `ci-release/SKILL.md:240` |
| `~/.config/ffnightly/ffactory.json` | the nightly's FF Factory URL and API key | a person | M | not seen | **yes** | `scripts/nightly/ffactory_intake.py:8-9,22` |
| `~/.steamcmd-home/` (M5) | steamcmd's own login cache (last-resort uploads) | a person | M | not seen | **yes** | ff-agents `mp-beta-deploy/SKILL.md:157-175` |
| `~/.codex/` (BEAST) | Codex's config | a person | M | not sized | yes | — |

### 1.7 Unity

| Path | For | Created by | Scope | BEAST size | Secret | Code |
|---|---|---|---|---|---|---|
| `C:\Program Files\Unity\Hub\Editor\6000.3.19f1\` (Hub default), `/Applications/Unity/Hub/Editor` | the editors | Unity Hub | M | not sized | no | `machine/unity.ts:214` (`editorBinary`: `unity_path`, `unity_editor_root`, the Hub's lists, its defaults) |
| `%APPDATA%\UnityHub` (`editors-v2.json`, `secondaryInstallPath.json`), `~/Library/Application Support/UnityHub` | where the Hub put editors | Unity Hub | M | 47 MB | no | `machine/unity.ts:214`; docs/machines.md "Finding Unity" |
| `%LOCALAPPDATA%\Unity\` (`Editor\Editor.log`, `cache\`, `licenses\`, `config\`) | the shared editor log, the package cache, the **licence** | Unity | M | 449 MB (`cache` 52 MB) | licence file | `machine/unity.ts:502-503`; `server/cleanup.ts:203-206` |
| `%USERPROFILE%\AppData\LocalLow\Unity\Caches\GiCache`, `~/Library/Caches/com.unity3d.UnityEditor/GiCache` | GI cache | Unity | M | 5 MB | no | `server/cleanup.ts:204,225` |
| `<sandbox>/Library/BurstCache`, `Library/ShaderCache`, `Library/Bee`, `Library/PackageCache` | the Burst, shader and build caches: **already per sandbox** (measured in `agent-mcp`) | Unity | S | inside each Library | no | — |
| `%USERPROFILE%\AppData\LocalLow\Never Games\finalfactory\` (Mac: `~/Library/Application Support/Never Games/finalfactory/`): `saves/`, `DeterminismAudit/`, `AgentControl/`, `desyncReports/`, `TestResults.xml` | the game's `persistentDataPath`, shared by every editor and player of that OS user | the game | M | 8.9 GB | `AgentControl/session-*.json` holds a bearer token | game `SaveGameManager.cs:217`; `scripts/nightly/lab.py:28-38`; ff-factory `server/agents.ts:167` (the brief) |
| `~/Library/Logs/Unity/` (Mac) | Editor.log and crashes | Unity | M | n/a | no | `machine/unity.ts:489`; `server/cleanup.ts:221-222` |

### 1.8 OS registrations

| What | For | Created by | Runs as | Code |
|---|---|---|---|---|
| `FFFactoryDaemon` scheduled task (Windows) | the daemon at logon, non-elevated, in the interactive session | deploy | the person | `server/machineDeployWin.ts:23,389-441` |
| `com.fffactory.daemon` LaunchAgent, `~/Library/LaunchAgents/com.fffactory.daemon.plist` | the daemon in the GUI session | deploy | the person | `server/machineDeploy.ts:17,187-190,358` |
| `ffsb-helper-mount`, `-trim`, `-compact`, `-detach`, `-reboot` tasks; `%ProgramData%\ffsb-helpers\` (`ffsb-helper.ps1`, `results\`) | the Dev Drive remount and maintenance (BEAST) | `scripts/install-privileged-helpers.ps1` (admin) | SYSTEM | `install-privileged-helpers.ps1:41-78`; `machine/hostGuard.ts` (w466) |
| `<root>\devdrive.vhdx` → volume `<letter>:` (any Windows install, w900; ReFS Dev Drive, first free letter from V: down) and `<root>\devdrive.json`; the same `ffsb-helper-mount`, `-trim` and `-compact` tasks, registered with `-Flex` | the sandboxes and the seed | `scripts/worker/devdrive.ps1` (admin), `scripts/install-privileged-helpers.ps1 -Flex` | SYSTEM | `docs/worker-install.md` "The Dev Drive" |
| `C:\ffsb-devdrive.vhdx` → volume `F:` (ReFS Dev Drive, 900 GB, 213 GB free; on the same NVMe as `C:`, measured) | BEAST's sandbox volume | `scripts/devdrive.ps1:8` (admin) | — | `scripts/devdrive.ps1` |
| `ffsb-server`, `ffsb-server-nologon`, `ffsb-update` (BEAST) | the **portal**, not a worker: they leave with w510 and the VM | `scripts/install-autostart.ps1` | the person | `scripts/common.ps1:7` |
| `ff-nightly-e2e-watchdog` (BEAST) | the nightly watchdog | `install_schedule.sh` over ssh | the person | `scripts/nightly/install_schedule.sh:27` |
| ad-hoc tasks `FF-Build-b2f087c8c-Editor`, `FF-LiveMP-e3d68fd01-PoweredMining-Host`, `ff-worker-leg`, `ff-detach-test` (BEAST) | left from honest co-op legs; one runs a player from `ff-worker\build-normal-e3d68fd01\main\` and one runs Unity elevated (`Highest`) | agents by hand | the person | none (measured with `Get-ScheduledTask`) |
| Windows Firewall rules | inbound allow for players and Unity | the firewall prompt, `setup_player_slot_firewall.ps1` (group "Final Factory player slots") | — | `setup_player_slot_firewall.ps1:29,77-107` |

## 2. The proposal: one root per machine

### 2.1 Layout

```text
<root>/                          F:\ffw (BEAST), D:\work\ffw (LothDesktop), /Users/Shared/ffw (Macs)
  root.json                      install id, layout version, every path outside the root it created (2.3)
  daemon/                        app/, app.new/, app.old/, daemon.json (no secrets), run-daemon.ps1,
                                 sandboxes.json, cleanup*, unity-slots/, unity-mcp/<place>/, max-events.jsonl
  secrets/                       owner-only files: the machine token, the ntfy topic, the gh token, the ssh key, the bot configs
  logs/                          daemon, supervisor, install, uninstall, migration, clean-up logs
  repo/                          the install's own bare clone of the game repo (git objects + LFS store)
  sandboxes/<name>/              worktrees of repo/, each with its Library
  seed/Library/                  the Library seed (same volume as sandboxes/, for block or APFS clones)
  players/slot0..slotN-1/        the player slot pool: slotK/player/finalfactory.exe, slot.json, leases/
  nightly/                       the nightly lab (FF_NIGHTLY_ROOT): its clone, builds, runs, logs, reports
  agents/<id>/                   standing agents assigned to this machine
  scratch/                       long-lived scratch (today's _scratch, ffsb-scratch, F:\tmp)
  tmp/ffa-<session>/             agents' TMP/TEMP/TMPDIR (temp_dir)
  claude/                        CLAUDE_CONFIG_DIR: settings, plugins, projects (transcripts, memory), .claude.json
  claude-medium/                 the Medium agents' CLAUDE_CONFIG_DIR (standing agents, w5543): read-only to workers
  cache-medium/uv/               the daemon's and Medium agents' UV_CACHE_DIR (the Unity MCP server's uvx, w5565): read-only to workers
  tools/final-factory-agents/    FF Factory's own checkout the agent tools publish runs registerAgents.sh from (w1476)
  home/                          GIT_CONFIG_GLOBAL (.gitconfig), GH_CONFIG_DIR (.config/gh), .ssh/config
  cache/                         UPM_CACHE_ROOT, npm and pip caches
```

`review/` is left out: review media stays on the portal (D9). No folder is named after a session, a branch or a
commit above `sandboxes/<name>` and `tmp/ffa-<session>`, and no executable runs from either (2.5).

**Path length.** Unity and its build tools still trip over Windows' 260-character paths. `F:\ffw\sandboxes\<name>` is
10 characters longer than `F:\ffsb\<name>`. *(Guess: that is within margin.)* w513 measures the longest path under a
current sandbox before it picks the folder names. A shorter `sb` instead of `sandboxes` is the fallback.

### 2.2 Volumes: subfolders may be mounts or junctions

- **BEAST.** `F:` is the Dev Drive, a VHDX on the same NVMe as `C:` (measured). It exists for ReFS block clones (the
  65 GB seed copies in seconds) and Dev Drive performance, and it is the volume Windows dropped on 2026-09-24. So the
  root goes on `F:` (`F:\ffw`), where `sandboxes/`, `seed/` and `players/` must share one volume: hard links into
  the slots (`player_slots.py:260`) and block clones need it. The daemon is what remounts `F:` (w466,
  `machine/hostGuard.ts`), so it cannot live there. `F:\ffw\daemon`, `secrets` and `logs` are **directory junctions to
  `C:\ffw-anchor\…`**. The scheduled task names the `C:` path directly, so the daemon runs while `F:` is gone. The
  anchor is the one item outside the root on BEAST, and `root.json` lists it.
- **A Dev Drive in the root (w900).** Any Windows install can have `<root>\devdrive.vhdx`, a VHDX mounted at the first free
  letter from V: down (`docs/worker-install.md`, "The Dev Drive"). `<root>\sandboxes` and `<root>\seed` are then directory
  junctions to `<letter>:\sandboxes` and `<letter>:\seed`, and `daemon.json` names the drive's paths. `daemon\`, `secrets\`,
  `players\` and the rest stay on the root's own volume: the daemon must run while the drive is gone, and the firewall
  rules name `players\`. `root.json` lists the drive (`devDrive`, and an `outside` entry for the three SYSTEM tasks).
- **A root on its Dev Drive (w1070).** A Windows install with a Dev Drive has its root on the drive, `<letter>:\ffw`, with
  no junctions; the folder given at install keeps the VHDX, `devdrive.json`, `moved.json` and, as BEAST's anchor does,
  `daemon\` and `secrets\`, which `daemon.json` names directly (`docs/worker-install.md`, "The whole root on the Dev Drive").
- **LothDesktop.** Root `V:\ffw` on its Dev Drive (`D:\work\ffw\devdrive.vhdx`, 275 GB at most), daemon and credential in
  `D:\work\ffw` (w1070, after its reinstall).
- **Macs.** One APFS container, so no junctions. `cp -c` clones the seed (`machine/sandboxes.ts`, the "Warm Library"
  rule).
- **Rules for junctions.** The installer creates them and `root.json` records each one with its target. Code never
  writes a path through a junction to git or Unity: a worktree's recorded path and a Unity project path are the
  canonical ones. The uninstall unlinks a junction before it deletes anything and never recurses through one. *(Guess:
  Windows PowerShell 5.1's `Remove-Item -Recurse` follows junctions into their targets; w513's uninstall test proves
  the safe path either way.)* `players/` is never a junction: the firewall rule must name the path the exe really
  runs from *(guess: a rule on a junction path may not match, because Windows resolves the image path; only a test
  would show it, and avoiding the junction makes the test unnecessary)*.

### 2.3 The install's own clone (lothsahn, 2026-10-06)

No agent runs in a person's clone. The install has `<root>/repo`, and every sandbox is a worktree of it. People's
clones (the old LothDesktop main clone (gone, 2026-10-10), the Macs' `~/nevergames/FinalFactory`, Ben's `C:\ffsb\_base`) are outside the install
entirely, so `ff-local-backups` is no longer needed.

- **Bare, not mirror.** `git clone --bare`, then set `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*`. A
  bare clone sets no fetch refspec, and `--mirror` maps `+refs/*:refs/*`, so a fetch would overwrite the sandboxes'
  local branches *(sourced: git-clone docs, `--bare` and `--mirror`)*. `git worktree add` works from a bare
  repository.
- **Nothing dangles.** A worktree's admin folder is `<root>/repo/worktrees/<name>`, and its `.git` file points back
  there. Both are inside the root, so deleting the root leaves no stale references anywhere. Today BEAST's sandboxes
  are registered in `C:\ffsb\_base\.git\worktrees`: 14 entries for 6 live sandboxes (measured), so the stale-entry
  problem exists already.
- **Relative worktree paths** would let a root be renamed or moved. Git 2.48 added them (`worktree.useRelativePaths`)
  *(sourced: Git 2.48 release notes; confirm before relying on it)*. BEAST has git 2.45.1 (measured), so this needs a
  git upgrade, or absolute paths and `git worktree repair` after a move.
- **Cost.**
  - Disk: about 10.3 GB per machine for the clone plus LFS at today's HEAD (git packs 1.22 GiB and 9.05 GB of LFS
    content at HEAD, measured on BEAST). The LFS store then grows with each new LFS version fetched: `_base`'s is
    8.4 GB (measured).
  - Fetch time: about 3 to 15 minutes from GitHub at 100 to 500 Mbit/s *(guess from the size; w513's install log
    measures it)*. Where a person's clone exists, the installer can take its objects with
    `git clone --bare --reference-if-able <clone> --dissociate`, which copies them locally and keeps no lasting link
    *(sourced: git-clone docs)*, and copy that clone's `.git/lfs/objects` read-only. That makes the fetch a local
    copy plus the delta from origin.
  - Each sandbox's checkout costs what it costs today.
- **The Library seed is still shared.** It is per machine and does not depend on the clone. Today `librarySource` takes
  the main clone's Library first (`machine/sandboxes.ts:117`). A bare clone has none, so the seed becomes the source
  (then a ready sandbox's, as today). BEAST's seed exists (65 GB, measured). LothDesktop's sandboxes were seeded from
  the old main clone's Library (docs/machines.md "Warm Library"; that clone is gone, 2026-10-10). Its installer copies that Library once, read-only, into
  `seed/Library`, or the first sandbox imports cold (many minutes, as the brief warns) and becomes the seed. The
  one-time script reimport after a copy stays (`machine/scriptReimport.ts`).
- **Daemon code a person's clone no longer needs** (removed in w536, 2026-10-06; the line numbers below are from before; see 5.2):
  - `machine/daemon.ts`: main-clone limits (`:917-925`), its editor and watch (`MacUnity(cfg.repoPath)`, `:216`,
    `:228`), its Unity slot holder `main` (`:714-716`, `:1115-1118`), its MCP place `_main-clone` (`:371`;
    `machine/unityMcp.ts:13-14`), its git status (`:768`), its branch switch (`:1071-1072`), its stale-output place
    (`:316`), its image listing (`:1156-1163`).
  - `machine/sandboxes.ts`: the main-clone overlap and name checks (`:95-99`, `:325-329`) point at `repo/` instead;
    `librarySource` drops the repo's Library (`:117`).
  - `server/guard.ts`: `ownCheckout`, `backupRootFor` and `backupRecipe` (`:54-56`, `:97-98`, `:151`, `:167-191`), and
    `server/agents.ts:1523`.
  - `server/machines.ts`: `mainCloneRefusal` and the main clone's `max_agents` (`:612-656`, `:738`), the clone probe
    (`server/machineDeploy.ts:110,319-320,485-498`; `server/machineDeployWin.ts:281-284`).
  - `server/standing.ts`: a standing agent on a machine runs "next to its main clone" (`:817-852`, the `repoNote`).
    It moves to `agents/<id>` with read access to `repo/` or a worktree of it.
  - `server/placement.ts`: main-clone computers in the Capacity block (docs/machines.md "Main-clone machines"); the
    M3 and the M5 become sandbox machines.

### 2.4 What moves by environment variables

A worker's environment is the daemon's process environment plus overrides (`server/launch.ts:186`:
`env: { MCP_TIMEOUT, ...baseEnv, GIT_TERMINAL_PROMPT, GCM_INTERACTIVE, ...publicGitEnv, ...spec.env }`, with `baseEnv`
the daemon's `process.env`). The editors the daemon starts inherit it too. So the installer sets these once in
`run-daemon.ps1` (Windows) or the plist's `EnvironmentVariables` (`server/machineDeploy.ts:187-190`).

| Variable | Points to | Moves | Basis |
|---|---|---|---|
| `CLAUDE_CONFIG_DIR` | `claude/` | settings, plugins (`registerAgents.sh` run with it set), `projects/` (transcripts, memory, resume); not the machine's own login, which stays in `~/.claude` | set by the daemon on itself at start since w5305 ([2.8](#28-claude-codes-folder-w5305)) |
| `TEMP`, `TMP`, `TMPDIR` | `tmp/` (the existing `temp_dir`) | agents' temp, Claude's task output | measured: today's mechanism, `machine/daemon.ts:58,126` |
| `GIT_CONFIG_GLOBAL` | `home/.gitconfig` | identity, credential helper | sourced: git-config docs (git 2.32+) |
| `GH_CONFIG_DIR` + `GH_TOKEN` | `home/.config/gh`, `secrets/gh-token` | gh's config; the token in place of the OS keyring, where BEAST's lives today (measured) | sourced: `gh help environment` |
| `GIT_SSH_COMMAND` | `ssh -F <root>/home/.ssh/config -i <root>/secrets/ssh/id_ed25519` | git over ssh | sourced: git docs |
| `UPM_CACHE_ROOT`, `ASSETSTORE_CACHE_PATH` | `cache/upm`, `cache/asset-store` | Unity's global package cache and Asset Store downloads | **in use** (w5297): `rootEnv`, `machine/sharedCaches.ts` `workerToolCacheEnv`; sourced: Unity manual, "Customize the global cache location" (the variable beats Preferences and the user config file) |
| `npm_config_cache`, `PIP_CACHE_DIR`, `NUGET_PACKAGES`, `DOTNET_CLI_HOME`, `PLAYWRIGHT_BROWSERS_PATH` | `cache/npm`, `cache/pip`, `cache/nuget/packages`, `cache/dotnet`, `cache/ms-playwright` | tool caches | **in use** (w5297): `workerToolCacheEnv`; sourced: each tool's docs |
| `XDG_CACHE_HOME` (macOS, Linux) | `cache/xdg` | every XDG-following tool's cache (gh, Mesa's shader cache, Unity's Linux editor cache). Not `XDG_CONFIG_HOME` or `XDG_DATA_HOME`: Unity's Linux licence and gh's login live there | **in use** (w5297); `server/outsideWrites.test.ts` fails if either is set |
| `GH_NO_UPDATE_NOTIFIER=1` | — | gh's update check (`state.yml` in its config folder) | **in use** (w5297); sourced: `gh help environment` |
| `TMP`, `TEMP` of a daemon-started editor (Windows) | `tmp/unity` | the sandbox editor's temp files (crash folders, Bee and shader-compiler scratch), not `%LOCALAPPDATA%\Temp` | **in use** (w5297): `machine/unity.ts` Windows `launch`, `editorTempEnv`. macOS and Linux unchanged: where Unity's licensing client keeps its socket there was not checked (guess: the system temp) |
| `-logFile` of a batch run | `<TMPDIR>/unity-<label>-<time>.log` | `unity-slot run -- <Unity> -batchmode ...` without its own `-logFile` wrote the person's Editor.log | **in use** (w5297): `machine/unitySlots.ts` run, `batchUnityLogFile` |
| `UV_CACHE_DIR` | `cache/uv` | uv's cache: every `uv run --with` environment the worker prompt prescribes (36.9 GB in `~/.cache/uv` on m5, 2026-11-23); the daemon runs `uv cache prune` on it daily (w5281) | **in use**: `machine/daemon.ts` `rootEnv`, `machine/sharedCaches.ts` |
| `CARGO_HOME` | `cache/cargo` | the cargo registry, index and git dependencies every ffu slot and worker cargo shares, which a fenced worker could not write in `~/.cargo` on C: (BEAST, "Access is denied (os error 5)"); one already inside the root stays, one outside it moves here, seeded once from the old one, which is only read (w5501) | **in use**: `machine/sharedCaches.ts` `workerCargoHome`, `machine/daemon.ts`, `docs/ffu-sandboxes.md` |
| `FF_DETERMINISM_AUDIT_DIR` | `cache/determinism-audit` | the game's determinism audits, in place of `<game data>/DeterminismAudit` (5.2 GB on m5); the game's retention bounds it (w5281) | **in use**: `rootEnv`; the game's `NetworkDeterminismAuditRetention.AuditRoot` |
| `FF_PLAYER_SLOT_ROOT`, `FF_PLAYER_SLOT_COUNT` | `players/`, 8 | the slot pool; ends the drive-letter probing in `default_root()` (`player_slots.py:69-79`), which had left BEAST with firewall rules for two pools (gone since; `default_root()` now returns `<FF_WORKER_ROOT>/players` or refuses) | measured: `player_slots.py:83-87` |
| `FF_NIGHTLY_ROOT` | `nightly/` | the nightly lab | measured: `nightly.sh:17-18` |
| `FFDISCORD_HOME` | `secrets/ffdiscord` | the Max bot config, where scripts honour it | measured: `nightly.sh:43`; whether the `ffdiscord` CLI itself does is unverified |
| `FF_MAX_EVENTS`, `FF_UNITY_SLOTS` | `daemon/…` | already set by the daemon from `app_dir`. The Unity slots mailbox stays at its standard place in the home folder (not under the root), where scripts outside the daemon (the nightly harness, a build by hand) find it with no config (w469) | measured: `machine/daemon.ts:713,882`; `machine/unitySlots.ts` `slotsDir` |
| `CFFIXED_USER_HOME` (Mac only, for players) | `home/` | a Mac player's `persistentDataPath` | measured: in use by `lab.py:28-34` |
| `FF_PLAYER_HOME` | `gamedata-home/` | a worker player's own home for Unity's PlayerPrefs: the game's `player_slots.player_home_env` and the timed runs (`machine/gameData.ts` `playerHomeEnv`) turn it into the player's `XDG_CONFIG_HOME=<it>/config` (Linux) or `CFFIXED_USER_HOME=<it>` (macOS), never the worker's own; nothing on Windows | **in use** (w5344): `rootEnv` |

**Not `HOME` or `USERPROFILE`.** Overriding the profile variables for every worker is tempting and wrong. On Windows,
Unity, the game and the licence find AppData through the profile's known folders. Win32-OpenSSH resolves `~` from
the account's profile. The Windows APIs Claude Code and node call would split between two homes. On a Mac,
the keychain and launchd are tied to the real home. *(Guess for each tool: the targeted variables above make the
question moot, which is why they are recommended.)*

### 2.5 Built players run only from `<root>/players/slotK`

The pool exists (w350, `scripts/nightly/player_slots.py`): a run leases a slot, mirrors the build in (hard links on the
same volume, a copy otherwise) and launches from `slotK/player/`. Rules are per exe path, so N slots need N rule sets
once per machine. The problem is the launches that bypass it. On BEAST, `Get-NetFirewallApplicationFilter` lists 382
rules for game, Unity, node and Claude executables over **183 distinct paths**: 16 slot paths, 163 non-slot
`finalfactory.exe` paths, one Unity, one node (measured). The non-slot ones, grouped:

| Rules | Path pattern | What made it |
|---|---|---|
| 58 | `C:\users\rydin\actions-runner-finalfactory-mode2\_work\_temp\finalfactory-mode2-build-…\` | the mode2 CI job on BEAST's runner: `GITHUB_ACTIONS=true` turns the pool off (`player_slots.py:94-98`), and `.github/scripts/mode2-ci-run.sh:35-41` runs from `$RUNNER_TEMP` |
| 18 + many 2s | `F:\ffsb\<sandbox>\builds\…\finalfactory.exe` | agents launching from their sandbox's build folder (most predate the pool, *guess from the names*) |
| 14, 6, 4, 2 | `%TEMP%\ffa-<session>\lab\builds\<sha>-win\player\`, `%TEMP%\ffa-…\builds\…`, `%TEMP%\finalfactory-mode2-build-…`, `%TEMP%\w25build\` | lab runs in agents' temp folders; the `{root}/player` shape matches `lab.py`'s remote fallback (*guess*) |
| 2 | `F:\ffsb-scratch\w159\builds\<sha>-win\player\` | a scratch build |
| (task) | `C:\Users\rydin\ff-worker\build-normal-e3d68fd01\main\finalfactory.exe` | the ad-hoc `FF-LiveMP-…` scheduled task (measured) |

Launches outside a slot that the code still allows (origin/develop, plugin 1.20.28):

1. **The mode2 CI jobs** (`.github/workflows/determinism-mode2.yml:32`, `determinism-nightly.yml:38` →
   `.github/scripts/mode2-ci-run.sh:35-41`): the pool is off on runners by design. Fix: the runner's service sets `FF_PLAYER_SLOTS=on`
   and `FF_PLAYER_SLOT_ROOT` (the runner is on BEAST, measured: its folder and its 58 rules), or it gets its own
   fixed slots. S, and decision 8.
2. **`lab.py`'s remote Windows peer** launches from `{root}/player` when its lease fails (`scripts/nightly/lab.py:97-111`,
   "launching from {spec['root']}/player"). Fix: refuse, as the local path does (`SlotRequired`). S, game repo.
3. **`run_build_multiplayer_audit.sh`** with `FF_PLAYER_SLOTS=off` (`player_slots.py:94-98`), and `slot_path` running a
   path as-is when it finds no player in it (`player_slots.py:180-191,600-605`). Fix: refuse in both cases on a worker
   machine. S.
4. **The determinism-audit skill** says to launch the Windows player "from `F:/ffsb/<name>/Builds/<leg>/`"
   (ff-agents `determinism-audit/SKILL.md:70`), as does the project-memory recipe
   `feedback-beast-work-goes-through-a-sandbox.md:90-91`. Fix: the slot pool wording, through
   `/ff-agents:publish-skills`. S.
5. **Ad-hoc scheduled tasks** that run players by path (`FF-LiveMP-…`, measured). Fix: retire them (decision 10), and
   the guard below.
6. `GameRelauncher` (`Assets/Scripts/Behaviours/GameRelauncher.cs:47-55`) relaunches the running exe at its own path:
   **not a violation** when that first launch came from a slot.

Every build output path (`BuildCommand2.cs:135,962`, `ShaderBenchBuild.cs`, `LightingBenchBuild.cs`, `ReleaseBuild.cs:82`,
`LocalMultiplayerVerificationBuild.cs:129`, `build_player.sh:16,51-52`) may stay where it is. A build folder is
harmless until something runs an exe from it. Nothing in the game repo builds or runs a dedicated server or a server
subtarget (searched `dedicated.?server|subtarget|EnableHeadlessMode`; headless players are the same exe with
`-batchmode -nographics`, and they go through the pool, `run_join_policy_smoke.sh:50`).

**Enforcement** (both S): the workers' guard refuses a shell command or a `Start-Process` naming `finalfactory.exe`,
`finalfactory.app` or `.app/Contents/MacOS/finalfactory` outside `<root>/players/` (the `server/guard.ts` path rules
already parse commands). The installer creates the slot rules in a group of its own, so the uninstall removes exactly
those. Optionally, `Set-NetFirewallProfile -NotifyOnListen False` turns an unknown listener into a silent block
instead of a prompt that stalls a run *(sourced: NetSecurity docs)*. It is machine-wide, so it is the owner's call
(decision 7).

**The Unity editor and sandboxes need no fixed paths.** A firewall application rule matches the program's path,
never its working folder or project (sourced: Windows Firewall application rules). BEAST has one Unity rule set, on
`C:\Program Files\Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe`, and none per sandbox, after months of editors in
many sandbox folders (measured). The editor's path changes only with a Unity upgrade: one prompt per version per
machine, which the installer pre-empts by adding a rule for each installed version. node (the daemon) only dials out:
its one rule is on the nvm path (measured).

### 2.6 What cannot move, and how it is referenced

Nothing below is a hard-coded path in the new code. Each is a key in `daemon.json` or `root.json` that the installer
fills from what it finds, and the uninstall reads.

| Item | Why it stays outside | Referenced by |
|---|---|---|
| Unity Hub and its editors; Unity's licence (`%LOCALAPPDATA%\Unity\licenses`) | shared with the person's own Unity; the licence is per OS user and machine, activated online (ff-agents `unity-personal-licence-is-activated-online.md`) | `unity_editor_root` / `unity_path` (exist today) |
| BEAST's Dev Drive (`C:\ffsb-devdrive.vhdx`), its `ffsb-helper-*` SYSTEM tasks, `%ProgramData%\ffsb-helpers` | admin and SYSTEM objects; the volume holds the root | `hostGuard.devDriveVhdx` and the helper task names (w466); `root.json.outside` |
| People's own clones and their `ff-local-backups` | not the install's | nothing: the install no longer uses them (2.3) |
| `FFFactoryDaemon` task / `com.fffactory.daemon` LaunchAgent, firewall rules, the ssh authorized key | OS stores | `root.json.outside` (name, kind) |
| The game's `persistentDataPath` on Windows (`LocalLow\Never Games\finalfactory`, 8.9 GB on BEAST) | Unity derives it from the profile's known folder, and the game has no override (searched `persistentDataPath\s*=` and data-root flags in `Assets/Scripts` and `scripts`; 48 uses in 34 files read `Application.persistentDataPath`) | `root.json.outside` for clean-up of saves the install made; decision 5 |
| `~/.unity-mcp` | the MCP-for-Unity editor plugin writes there (`machine/unityMcp.ts:75`) | the daemon's `unityMcpServer` / status-dir setting |
| `%ProgramData%\FinalFactory\player-slots.json` | **can go**: with `FF_PLAYER_SLOT_ROOT` set by the daemon it is no longer read | — |

### 2.7 What still writes outside the root, per OS (w5297, 2026-11-23)

lothsahn (w5297): "under no circumstances should workers write outside of ffw." This is the inventory from the code
(this repo, the game repo's scripts and the ff-agents skills), not from a disk scan. `server/outsideWrites.test.ts` fails
when a new place in the daemon names the home folder, AppData or the system temp, or a folder in `rootEnv` leaves the root.
**Fixed** means moved into the root; **next** means a step handed up under w5297; **exception** stays outside, with why.

| What | Windows | macOS | Linux | Status |
|---|---|---|---|---|
| uv cache, determinism audits | `~/.cache/uv`, `<game data>/DeterminismAudit` | same | same | **fixed** (w5281): `cache/uv`, `cache/determinism-audit` |
| pip, npm, NuGet, dotnet, Playwright caches | `%LOCALAPPDATA%\pip`, `%LOCALAPPDATA%\npm-cache`, `~/.nuget`, `~/.dotnet`, `%LOCALAPPDATA%\ms-playwright` | `~/Library/Caches/...`, `~/.npm`, `~/.nuget` | `~/.cache/...`, `~/.npm`, `~/.nuget` | **fixed** (w5297): `cache/<tool>` |
| Unity Package Manager and Asset Store caches | `%LOCALAPPDATA%\Unity\cache`, `%APPDATA%\Unity\Asset Store-5.x` | `~/Library/Unity/cache` | `~/.config/unity3d/cache` | **fixed** (w5297): `cache/upm`, `cache/asset-store` |
| XDG caches (gh, Mesa, Unity's Linux cache) | — | `~/.cache` | `~/.cache` | **fixed** (w5297): `cache/xdg` |
| gh's update check | `%APPDATA%\GitHub CLI\state.yml` | `~/.config/gh/state.yml` | same | **fixed** (w5297): `GH_NO_UPDATE_NOTIFIER` |
| A batch Unity run's log with no `-logFile` | `%LOCALAPPDATA%\Unity\Editor\Editor.log` | `~/Library/Logs/Unity/Editor.log` | `~/.config/unity3d/Editor.log` | **fixed** (w5297): the worker's `TMPDIR` |
| A sandbox editor's temp files | `%LOCALAPPDATA%\Temp` | `/var/folders/...` | `/tmp` | **fixed** on Windows (`tmp/unity`); **exception** on macOS and Linux until the licensing client's socket is checked there |
| Agents' temp | — | — | — | already inside: `tmp/ffa-<session>` |
| Claude Code's folder (transcripts, plugins, settings) | `%USERPROFILE%\.claude` | `~/.claude` | `~/.claude` | **fixed** (w5305): `claude/`, once the tools publish has installed the plugins there ([2.8](#28-claude-codes-folder-w5305)); the machine's own login and registerAgents.sh's marker stay (**exception**) |
| The game's data folder (saves, settings, AgentControl, desync reports, playtest sessions, timed runs' save copy) | `AppData\LocalLow\Never Games\finalfactory` | `~/Library/Application Support/Never Games/finalfactory` | `~/.config/unity3d/Never Games/finalfactory` | **fixed** (w5306): the daemon sets `FF_GAME_DATA_DIR=<root>/gamedata` (`rootEnv`, `machine/gameData.ts`), which `GameDataPaths.Root` takes since game PR #4237, and so do the game's `scripts/game_data.py where` and `player_slots.py` (`FF_GAME_DATA_ROOT` first, then `FF_GAME_DATA_DIR`, w5307). A branch or player build from before #4237 ignores it and still writes the old folder, so the daemon's readers look in both: the live view's session files (`machine/live.ts` `agentControlDirs`, the override first) and the timed run's save copy (`machine/timedRunner.ts`: `savesDirsFor` reads each build's `FFCore.dll` for the variable's literal and copies the save where that build loads it, both folders when it cannot tell) |
| A slot player's `Player.log` | `LocalLow\...\Player.log` | `~/Library/Logs/Never Games/...` | `~/.config/unity3d/.../Player.log` | **fixed** (game PR #4237): `player_slots.py launch` passes `-logFile` under the worker's temp folder when `FF_WORKER_ROOT` is set and the caller gave none |
| watch_video's cache and spend file | `~/.cache/watch_video`, `~/.config/ff-watch-video/spend.json` | same | same | **fixed** (w5307, final-factory-agents#1026): `cache/watch_video`, `cache/ff-watch-video/spend.json` when `FF_WORKER_ROOT` is set; the key file `gemini.env` stays in `~/.config/ff-watch-video`, a person's own secret |
| honest-coop `agent_http` screenshots | beside the script in the plugin cache | same | same | **fixed** (w5307): the temp folder |
| The game repo's scripts naming the game's data folder (69 audit, agent, feel and bench scripts, record_clip, honest-coop `agent_http`) | `AppData\LocalLow\Never Games\finalfactory` spelled out | `~/Library/Application Support/...` | `~/.config/unity3d/...` | **fixed** (w5307, FinalFactory#4239): they read `game_data.py root` / `scripts/game_data_root.sh`, `FF_GAME_DATA_ROOT` first, so they follow the game's data folder when it moves; `test_no_stale_game_data_paths.py` fails on a new one |
| Game scripts' scratch files (cross-machine audits, editor-preflight, sp-dumpcamps diff, agent smoke tests) | — | `/tmp`, `/private/tmp` | `/tmp` | **fixed** (w5307): `$TMPDIR`, and over ssh the client's own `TMPDIR` |
| `launch-editor.sh`'s editor log, `ffresume`'s settings | Unity's default `Editor.log`, `~/.ffresume.json` | same | same | **fixed** (w5307): `logs/unity/editor-<checkout>.log` when `FF_WORKER_ROOT` is set and `FF_EDITOR_LOGFILE` is not; `<root>/ffresume.json` first |
| `run_cross_machine_build_audit.sh`'s player build | — | `/private/tmp/finalfactory-mp-audit` | — | **exception** (w5307): the build is copied to the same path on both Macs, so it cannot follow one machine's `TMPDIR`; `FF_BUILD_DIR` moves it |
| Remote fallbacks in the cross-machine audits | — | the client's `~/Library/Application Support/...`, `/tmp` | — | **exception** (w5307): used only when the client cannot answer `game_data.py root` or its `TMPDIR` over ssh |
| The nightly lab's helpers, `steam_cloud_check.py`, `seed_load_list_saves.py` | the per-OS data folder spelled out | same | same | **exception** (w5307): `nightly/player_slots.py` and `pair_relay.py` are copied alone to other machines, so each keeps its own copy of the per-OS rule, `FF_GAME_DATA_ROOT` first; `lab.py` and `ffnightly_linux.py` name the lab's other machines' and lab users' folders; `steam_cloud_check.py` names Steam Cloud's relative path; `seed_load_list_saves.py` builds a throwaway XDG root on purpose. Each is listed with its reason in the game repo's `test_no_stale_game_data_paths.py` |
| Unity slots mailbox and shims | `<root>/unity-slots` | same | same | **fixed** (w5377): a worker root's own; the daemon sets `FF_UNITY_SLOTS` for all it starts, and `slotsDir()` finds it from `FF_WORKER_ROOT`. Outside a worker root it stays `~/.ff-factory/unity-slots` (w469) |
| `~/.unity-mcp` (status files, port registry) | yes | yes | yes | **exception**: the MCP-for-Unity package's port registry has no setting (`PortManager.cs:316`, v10.3.0), and the daemon reads the editors' files there (`server/unityHang.ts`, `server/unityMcp.ts`) to mirror them per place into `UNITY_MCP_STATUS_DIR` (`machine/unityMcp.ts`) (w5307) |
| Unity's own logs and licence, Unity Hub | `%LOCALAPPDATA%\Unity`, `%APPDATA%\UnityHub` | `~/Library/Logs/Unity`, `~/Library/Unity` | `~/.config/unity3d`, `~/.local/share/unity3d` | **exception**: shared with the person's Unity; the licence is per OS user |
| EditorPrefs (Burst) and an editor's PlayerPrefs (the perf test framework's `PT_Run`, Addressables' `AddressablesRuntimeDataPath`) | registry `HKCU\Software\Unity Technologies`, `HKCU\Software\Unity\UnityEditor\Never Games\finalfactory` | `~/Library/Preferences/com.unity3d.*.plist`, `unity.Never Games.finalfactory.plist` | `~/.local/share/unity3d/prefs`; the editor's PlayerPrefs file not located | **exception** (w5344): Unity's own stores; moving an editor's home would move its licence and EditorPrefs with it, not tried |
| A player's Unity PlayerPrefs (the native `Screenmanager *` keys at every quit, Unity Services' installation id and auth tokens on a Relay start, Backtrace's `backtrace-machine-id`; game repo `Documentation/User-Data-Folder.md`, "What still writes PlayerPrefs (w5343)") | registry `HKCU\Software\Never Games\finalfactory` | `~/Library/Preferences/com.Never-Games.finalfactory.plist` | `~/.config/unity3d/Never Games/finalfactory/prefs` | **fixed** on Linux and macOS (w5344): the daemon sets `FF_PLAYER_HOME=<root>/gamedata-home` (`rootEnv`), and a player of a build that reads `FF_GAME_DATA_DIR` gets `XDG_CONFIG_HOME=<it>/config` (Linux) or `CFFIXED_USER_HOME=<it>` (macOS, the real Steam folder linked in) from the game's `player_slots.player_home_env` (slot launches, `lab.py`, pair legs) and from `playerHomeEnv` (`machine/gameData.ts`, timed runs). **exception** on Windows: no variable moves HKCU; a separate local account per worker would, not built |
| App Nap off for Unity | — | `defaults write <Unity> NSAppSleepDisabled` | — | **exception**: a user default |
| The daemon's OS job, firewall rules, ssh key, BEAST's Dev Drive and helper tasks | scheduled task, firewall | LaunchAgent plist | transient systemd unit; CI runner drop-ins | **exception**: OS stores |
| git and gh logins | `~/.gitconfig`, `%APPDATA%\GitHub CLI` | `~/.gitconfig`, `~/.config/gh` | same | **exception**: the person's own logins; agents use `GH_TOKEN` and `GIT_CONFIG_*` and write neither |
| The performance package's `TestResults.xml` and `PerformanceTestResults.json` | `<persistentDataPath>/TestResults.xml` | same | same | **exception** (w5306): `com.unity.test-framework.performance` `Editor/PerformanceTestRunSaver.cs` writes both to `Application.persistentDataPath` after every editor test run, whatever `-testResults` says, and `persistentDataPath` has no setting. The daemon starts no test run itself (no `-runTests` in `machine/` or `server/`), and the game's own runs read their results from `-testResults` or the MCP job, never this file (CLAUDE.md). A few kB, overwritten each run |
| Backtrace's crash database | `<persistentDataPath>/backtrace` | same | same | **fixed** (w5348, game PR #4260): when `FF_GAME_DATA_DIR` is set, `BacktraceVersionedDatabase.Redirect` points the client's database at `<root>/gamedata/backtrace` before any `Awake`, where `NativeCrashCollector` already read its sessions; players keep `${Application.persistentDataPath}/backtrace` (`Assets/Main Backtrace Configuration.asset:44`). A branch or build from before that PR still writes the old folder |
| The Unity editor's Analytics file (`Unity/<project cloud id>/Editor/Analytics/values`, about 140 bytes of engine and app version) | `AppData\LocalLow\Never Games\finalfactory\Unity\...` | `~/Library/Application Support/Never Games/finalfactory/Unity/...` (expected; not seen) | `~/.config/unity3d/Never Games/finalfactory/Unity/...` | **exception** (w5348): the editor's own analytics writes it under `persistentDataPath` on every launch even with the project's Unity Analytics off (`ProjectSettings/UnityConnectSettings.asset` `UnityAnalyticsSettings.m_Enabled: 0`; BEAST's copy last written 2026-11-23 14:11 by a 6000.3.19f1 editor). Unity documents no command-line option or environment variable that moves or stops it: the manual's only switch is Preferences > General > Disable Editor Analytics (an EditorPrefs value, a person's setting) or the Unity ID privacy page ([EditorAnalytics](https://docs.unity3d.com/Manual/EditorAnalytics.html)). `persistentDataPath` itself has no setting on Windows (the LocalLow known folder) or macOS (the home folder); on Linux it follows `XDG_CONFIG_HOME` ([persistentDataPath](https://docs.unity.com/en-us/engine/6000.3/script-reference/unityengine/application/persistentdatapath)), but setting that for the editor also moves every child process's config (git, gh) and Unity still writes some files to `~/.config/unity3d` ([UUM issue, Won't Fix](https://issuetracker.unity3d.com/issues/linux-editor-saves-some-data-to-slash-dot-config-slash-unity3d-even-if-xdg-config-home-is-redefined)), so it is not used. Slot players write no such file (none on BEAST) |
| Steam | the Steam client's own folders | same | same | **exception**: the person's Steam |
| `ff-leftovers launch` (a program for a person) | its temp and home | same | same | **exception** (w4047): the person goes on using it |

### 2.8 Claude Code's folder (w5305)

lothsahn (w5297): "under no circumstances should workers write outside of ffw". Before w5305 a main install left
`CLAUDE_CONFIG_DIR` unset, so every agent's transcripts, plugins and settings went to the person's `~/.claude` (8.6 GB on
m5); only `worker.ts install --instance` set it, in `daemon.json` `env`. Now `server/claudeHome.ts` moves a worker root's
agents to `<root>/claude`, in four parts that landed together:

1. **The daemon's own environment.** At start (`machine/daemon.ts`, after `rootEnv`) `moveClaudeHome` sets
   `CLAUDE_CONFIG_DIR=<root>/claude` on `process.env`, makes the folder and remembers the one it left in
   `FF_CLAUDE_LEGACY_DIR` (and `FF_CLAUDE_WORKER_DIR`). Every reader that follows the variable looks there: the transcript
   scrubber (which scans the legacy `projects/` too), `cliTranscriptPath`, plugin paths (`FF_SKILLS`), the evidence gate.
   It does nothing when `daemon.json` `env` names a `CLAUDE_CONFIG_DIR` (an instance's own) or sets `FF_CLAUDE_HOME` to
   `legacy` (the off switch).
2. **Plugins before agents.** `worker.ts tools` (the rollout's tools publish after each verified portal deploy) runs
   `registerAgents.sh` with `CLAUDE_CONFIG_DIR=<root>/claude`, so the plugins (the machine's remembered set, ff-discord
   included where a person asked for it) install there. Until `<root>/claude/plugins/installed_plugins.json` lists
   ff-agents with a skills folder, each agent launch runs with `CLAUDE_CONFIG_DIR` unset (`agentClaudeEnv` in
   `server/launch.ts` `buildOptions`), on the legacy folder as before, so skills load either way. The person's own
   `~/.claude` plugins are no longer updated by the publish: they are theirs.
3. **Resume.** Before a conversation's process resumes (`server/sessions.ts` `launchResumed`), `carryTranscript` copies its
   `<id>.jsonl` and `<id>/` folder (subagents, tool results) from the legacy `projects/<cwd>/` into the new one; it copies,
   never moves, and the session's log says so. `cliTranscriptPath` looks in both folders. An agent already running in an
   agent host keeps the folder it started with until its process ends.
4. **Settings and config.** `settings.json` is carried once (marker `<root>/claude/.ff-settings-carried`) by the daemon's
   start or the tools publish, whichever runs first: keys the new file lacks, never `enabledPlugins`,
   `extraKnownMarketplaces`, credential helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
   `otelHeadersHelper`) or an `env` entry whose name looks like a secret. The Unity MCP entry is read from
   `<root>/claude/.claude.json` first, then the person's `~/.claude.json`, where MCP for Unity registers it
   (`machine/unityMcp.ts`).

What stays in `~/.claude`, on purpose:

- **The machine's own claude.ai login.** macOS keeps it in the Keychain under a name that depends on `CLAUDE_CONFIG_DIR`,
  Windows and Linux in `~/.claude/.credentials.json`; it is never moved or copied. The usage probe (`loginClaudeEnv`) and an
  agent with no Claude credential of its own run with the variable unset. Every portal agent has a vault token
  (`server/secrets.ts`), so in practice only the probe reads it.
- **registerAgents.sh's checkout marker and plugin set** (`$HOME/.claude/final-factory-agents-checkout`, `-plugins`):
  registerAgents.sh writes them and publish-skills reads the marker at that fixed path (final-factory-agents
  `registerAgents.sh:40-41`, `publish-skills/SKILL.md:22`), so `server/agentTools.ts` and `server/strayWrite.ts` keep
  reading them there. Moving them is a change in final-factory-agents first.

**The Medium agents' folder** (w5543, item 6 of the w5451 audit; lothsahn: "File it: separate Claude settings folder for
Medium agents"). On a machine only a sandbox launch is fenced (`machine/daemon.ts` runSpec); a standing agent runs at
Medium. Loading settings, hooks and plugins from `<root>/claude`, which every worker can write, let a worker plant a
hook a Medium agent would run. So an agent with no sandbox gets `CLAUDE_CONFIG_DIR=<root>/claude-medium`
(`FF_CLAUDE_MEDIUM_DIR`; `server/launch.ts` `buildOptions`, `server/claudeHome.ts` `agentClaudeEnv(..., medium)`), and
the evidence gate's pr_evidence.py lookup reads its plugins there (`mediumPluginClaudeEnv`). The folder is kept Medium on
Windows (`machine/lowIntegrity.ts` `MEDIUM_CHILDREN`) and read-only under the Landlock and Seatbelt fences
(`machine/writeLock.ts` `LOCKED_CHILDREN`, `server/workerFence.ts` `READ_ONLY_IN_ROOT`).
- **Plugins**: the tools publish (`server/agentTools.ts`) runs registerAgents.sh from its one checkout into both folders,
  workers' first, in the same run; either failing fails the publish, so the two cannot drift. The Medium run logs
  `Agent tools before/after (Medium agents, <dir>):`, which the rollout's parser does not read. Until its
  `installed_plugins.json` lists the plugins, a Medium agent uses `~/.claude` as before w5305, never `<root>/claude`.
- **Settings** are carried once from `~/.claude` (never from the workers' folder) by the daemon and the tools publish.
- **Transcripts**: a standing agent resumed after the update has its session copied once from `<root>/claude/projects`
  (`claudeDirs` order: own, workers', Medium, legacy); the transcript scrubber reads `claude-medium/projects` too.
- Proven by `server/claudeHome.test.ts` (a live claude run: a SessionStart hook planted in `<root>/claude` writes no
  marker for a standing spec, the Medium folder's own hook does, and a sandbox spec runs the planted one; RED with the
  launch.ts change reverted) and the live fence tests in `server/writeLock.test.ts` and `server/workerFence.test.ts`.

**The Medium uv cache** (w5565, item 5 of the w5451 audit; lothsahn: "File it: separate uv cache for the daemon and Medium
agents"). The daemon and every Medium agent ran uvx (the Unity MCP server) and `uv run --with ...` from `<root>/cache/uv`,
which fenced workers write. Now the daemon's `UV_CACHE_DIR` is `<root>/cache-medium/uv` (`machine/daemon.ts` `rootEnv`,
`machine/sharedCaches.ts` `mediumUvCacheDir`; one an older daemon carried over moves, one daemon.json names stays:
`mediumUvCacheFor`), and a sandbox agent gets the workers' `<root>/cache/uv` back (`runSpec`, `sandboxUvEnv`). The daemon
fills both with the Unity MCP package at start, Medium first, and prunes each with its own `UvCachePruner`. `cache-medium`
is in `MEDIUM_ONLY_CHILDREN` (`server/claudeHome.ts`) with `claude-medium`, so all three fences keep it from workers.
Measured on biscuit under `ff-landlock.py` (w5565): a fenced `uvx` with the Medium cache fails "Failed to initialize
cache ... Permission denied (os error 13)" and a planted file is refused; the same run on `<root>/cache/uv` installs and runs.

**Checking the switch on a machine** (w5305's rollout). An agent that was already running when its daemon updated is
adopted with its old environment, so it still writes to and reads skills from `~/.claude`. That proves nothing either
way. Look at a session that resumed or started after the update instead: `search_transcripts` for `"to resume there
(w5305)"` (the copy line, per machine), a new session whose tool-result paths sit under `<root>/claude/projects`, and a
`Skill` call or `$FF_SKILLS` read in that session. On 2026-11-23 the evidence was: m5 for all three; on beast, the
resume of session 18a727ef and new session 3a461250's `ff-agents:ffu-build-test`; on lothdesktop, the resumes of
1f034014 and f4e700b8 and new session 175a86ee's `$FF_SKILLS` reads; on biscuit, the resume of 7b2e9b25.

## 3. Install, uninstall, upgrade

**One installer per OS** (w513): `install-worker.ps1` (Windows; the parts that need an administrator say so and run
once: the firewall rules, the helper tasks on BEAST, the authorized key) and `install-worker.sh` (macOS). In order,
each step idempotent:

1. Check: OS, node ≥ 22.6, git and git-lfs, Claude Code's native binary, free space on the root's volume (the clone
   about 10.3 GB, the seed about 65 GB, `disk_warn_gb` + 30 GB for the first sandbox, docs/machines.md), and that
   nobody else's install is there.
2. Create the root and `root.json` (`installId`, `layout: 1`, the machine id, `outside: []`); on BEAST, the anchor and
   its junctions. ACLs: `secrets/` owner-only (`icacls /inheritance:r /grant:r <user>:F`, or `chmod 700`).
3. Clone `repo/` (2.3), with `--reference-if-able` when a person's clone is given.
4. Seed: copy a Library read-only into `seed/Library` if one is given, else leave it for the first sandbox.
5. Players: create `players/slot0..7`, add the firewall rules for those paths and each installed Unity version, and
   record the rule group in `outside`.
6. Claude: with `CLAUDE_CONFIG_DIR=<root>/claude`, run `registerAgents.sh` (the plugins), and write `unityMcpServer`
   into `daemon.json`, so the daemon no longer reads a person's `~/.claude.json` (`machine/unityMcp.ts:32`). No login is
   needed: the machine's workers run on a vault token the portal sends in each launch spec (w1078; before, on the host token
   with `machines.useHostClaudeEnv`, or on the machine's own login, docs/machines.md "Claude account").
7. Secrets in (below). Then `daemon.json` without the token, the env block, and the service (the existing deploy code,
   pointed at the root). Record the task or plist in `outside`.

**How secrets get in.** The machine token comes from the portal (`add_machine` issues it today and writes it into
`daemon.json`). The installer takes it as a one-time argument, or the portal's deploy writes it, into
`secrets/machine-token`. The installer generates the ssh key (`secrets/ssh/`) and prints the public half for the peers'
`authorized_keys`. The gh token, the ffdiscord, ffbox and ffnightly configs and the ntfy topic are copied in from
the person's existing files, by path, once, never printed, and only where that machine needs them (LothDesktop: the
Max bot). The Claude OAuth token is never written on a machine: it arrives in each launch spec over the
authenticated link (docs/machines.md "Claude account"). The guards protect `secrets/` and `claude/` as they protect
`~/.ssh` and `~/.claude` today (`server/secretGuard.ts:167-177`, `server/guard.ts`).

**Uninstall** leaves nothing outside `root.json.outside`, and removes that list:

1. Refuse if a sandbox has commits not on origin or uncommitted files, listing them (the person decides). `--dry-run`
   lists everything it would remove.
2. Stop the daemon and every editor and player started from the root (by command line under the root, through the
   daemon's own stop: never Unity Hub, never another project's editor).
3. Unregister the task or LaunchAgent, remove the firewall rule group and, on BEAST, the helper tasks only if this
   install created them.
4. Unlink the junctions, then delete the anchor and the root.
5. Check: no task, rule or plist names the root; no `.git` file anywhere points into it (it cannot: 2.3); write the
   result to a log beside the root (the root is gone).

It leaves Unity Hub and its editors, the licence, people's clones, their own `~/.claude`, `~/.ssh` and gh login, and
the OS user.

**Upgrade.** The portal's redeploy already swaps `app.new` → `app` → `app.old` (`server/machineDeployWin.ts`, step 3),
which now happens inside `daemon/`. A layout change bumps `root.json.layout`, and its upgrade step is idempotent (it
runs again harmlessly), like the game's save upgrade steps.

**Re-provisioning a machine.** Either uninstall and install (sandboxes are lost unless pushed: the uninstall's step 1
says which), or `install --repair`, which keeps `repo/`, `sandboxes/`, `seed/` and `players/` and rewrites the service,
the env block and the secrets.

## 4. Containment: what the daemon runs as

| | A. The person's account, everything in the root (recommended now) | B. A dedicated local user per machine | C. A VM or container |
|---|---|---|---|
| Files | agents can still read the person's home; the guard protects named paths (today's model) | real separation: the OS stops agents reading the person's files | strongest |
| Unity and GPU | works today: the daemon runs in the interactive session for the Claude login, the GPU and the desktop (`server/machineDeployWin.ts:389-441`, "What runs it" in docs/machines.md) | the worker user must be logged on in its own session. Windows 11 Pro keeps several sessions with fast user switching, but only one owns the console; whether Unity renders and play mode runs in a background session is untested *(guess: risky)*. After a reboot only one account can sign in automatically (BEAST signs Ben in, beast-machine.md) | no GPU on Windows client without passthrough; Metal does not reach a macOS VM's guests usefully *(guess)* |
| Licences and logins | the person's | its own Unity licence activation, Claude login or the portal's token, gh token, Steam if ever needed | the same as B |
| Install cost | the installer above | plus creating the user, its auto-logon or session, and ACLs | far more |

**Recommendation:** A now: the root gives "easily contained, installed and deleted" without an OS user. Then B as a
measured experiment on one machine (LothDesktop, or the M3, whose owner is Ben): a second user in a background session,
with an editor's play-mode screenshot and a built player's 60 fps clip, checked while another person uses the
console. Adopt B if both pass. The layout already allows it: the root sits outside any person's home on every
machine (the reason the Macs' root is `/Users/Shared/ffw`, not `~/ffw`), and switching is a change of the service's
principal and the root's ACLs.

**A write fence without a second user (macOS, w5333):** docs/worker-fence.md, off by default.


### 4.1 Windows trial: writes only to the root (w5333, LothDesktop, 2026-11-23)

lothsahn (w5333): "Regardless of user the workers should only write to the v: on windows. Ideally they'd only be allowed
to do that." The target: whatever account runs them, workers and the editors, players and tools they start can write
only under the root (`V:\ffw` on LothDesktop); every write elsewhere, C: included, is refused by the OS.

**B (a dedicated user) does not meet it, and cannot be made without C:.** Measured on LothDesktop: the daemon's shell is
not elevated (UAC on, Administrators deny-only), so creating a user needs an admin's elevation; and any local account
lives in the SAM hive and the ProfileList key on C:, and its first logon makes `C:\Users\<user>` and its `NTUSER.DAT`
there (a profile folder can be moved later, the registry entries cannot). A dedicated user also still writes its own
profile, `C:\ProgramData`, `C:\Users\Public` and every other folder Users or Everyone may write, unless each is denied
by hand.

**What meets it without a new user: Windows integrity levels.** A process at Low integrity cannot write to an object
labelled Medium, and every unlabelled file, folder and registry key counts as Medium (no-write-up). Label the root Low
(`icacls V:\ffw /setintegritylevel (OI)(CI)low`, which its owner may do with no admin and nothing on C:) and start
workers at Low: they write inside the root and nowhere else. Measured at Low integrity in a Low-labelled folder under
`V:\ffw\tmp` (the trial's zone), same account, no admin:

| Check | Result (measured) |
|---|---|
| Writes: root zone / an unlabelled `V:\ffw` folder / `D:\` / `E:\` / `C:\` / the C: profile / `HKCU\Software` | allowed / refused / refused / refused / refused / refused / refused (a Medium control wrote the unlabelled folder) |
| The daemon's folder (`D:\work\ffw\daemon`) | unlabelled on D:, so Medium: refused by the same rule as `D:\` (not written to by name) |
| How a worker starts at Low | a Low-labelled copy of an exe starts at Low from a Medium parent and its children inherit it: a copy of `node.exe` and of `cmd.exe` in the zone both ran at Low. No native helper and no `CreateProcessAsUser` needed |
| git (init, commit, https clone), git-lfs, gh by token, node, PowerShell, Claude Code (`claude --version`) | all work |
| git push/fetch auth | the current `GIT_CONFIG_*` helper (`!gh auth git-credential`) fails, since it runs msys `sh`; a config-only `http.https://github.com/.extraheader` with the token works |
| Git Bash (msys) | crashes (0xC0000022) on the `msys-2.0` shared memory that the person's Medium Git Bash processes hold; a copy of `usr\bin` at another path gets its own section and works (`/cygdrive/<drive>` paths without an fstab) |
| Unity 6000.3.19f1 licence | works (the licensing client starts and serves the editor) |
| GUI editor (DX12) | works once `APPDATA`, `LOCALAPPDATA` and `USERPROFILE` point into the root; without that it stops on a modal "Moving file failed" (its Roaming preferences are refused) |
| Batch player build | works: `Build Finished, Result: Success`, 89 MB player |
| A built player, windowed | works: 800x600, 601 frames in 10 s, quits by itself |
| The game (slot3-0 build b8b30f4a08), windowed, `-ffSoloQuitAfterSeconds 60` | runs and quits by itself; Steam login works ("Connected to Steam"); Steam Input's controller shared memory fails (`Failed creating file mapping SteamController_Master_mem`), so Steam controller input is likely lost at Low (a guess, no controller tried) |
| `ff-leftovers end` | missed a Low-integrity editor (it was then closed by hand through its window); the sweep must see Low processes |

**The holes.** Windows labels a few places Low for its own sandboxed apps, so a Low worker can still write there:
`%USERPROFILE%\AppData\LocalLow` and `HKCU\Software\AppDataLow` (and any other object something already labelled Low). Measured: Unity's
`persistentDataPath` and GI cache go to LocalLow whatever `USERPROFILE` says, and the game build above (older than
`FF_GAME_DATA_DIR`) wrote its Workshop blueprint copy into the person's `LocalLow\Never Games`. Closing them: the game's
`FF_GAME_DATA_DIR` (in the game since d28c91db85) and Unity's GI cache folder preference move our own writes; a one-time
`icacls %USERPROFILE%\AppData\LocalLow /setintegritylevel (OI)(CI)medium` by the person closes the folder for every Low
process (it touches C:, and breaks any other app that sandboxes itself at Low there; none was found on LothDesktop, a
guess).

**The shared compiler server (w5347): a Low Unity broke every editor's compile, and the fix that held.** Unity's Bee
compiles with `<Editor>\Data\NetCoreRuntime\dotnet.exe exec <Editor>/Data/DotNetSdkRoslyn/csc.dll /shared`, and the
first compile starts a Roslyn server (`VBCSCompiler.dll`) that every later compile reaches by a named pipe. Roslyn names
the pipe from the user, elevation and the compiler's folder only, not the integrity level, and `csc.dll` has no
environment switch to turn the server off or rename the pipe (its strings name only `DOTNET_HOST_PATH` and
`RoslynCommandLineLogFile`; Bee passes `/shared` itself, so `UseSharedCompilation=false`, an MSBuild property, does not
reach it). So the trial's Low batch build started a Low server on the default pipe of `C:\Program Files\Unity\Editor\
6000.3.19f1`, and every Medium editor and batch build on the machine then handed it their compiles, which it wrote with
its Low token: `error CS2012: Cannot open 'V:\ffw\sandboxes\slot1\Library\Bee\artifacts\...dll' for writing -- 'Access to
the path ... is denied.'` (w5342: slot1's player builds and slot6's editor, until the server, dotnet pid 46552, ended).

- *Reproduced (measured, LothDesktop, 2026-11-23):* two junctions on V: to the install's `Data` folder give two pipes. A
  Low client through junction A started server pid 10324 at **Low (RID 0x1000)**; a Medium client through A then failed
  with the same CS2012 on its Medium output folder; a Medium client through junction B compiled and started its own
  Medium server. The default-path server of the real install (Medium, another worker's) was untouched throughout.
- *Fix (measured):* launch a Low Unity through a junction in the root to its `Editor` folder (`mklink /J
  <root>\...\unity-low\6000.3.19f1 "C:\Program Files\Unity\Editor\6000.3.19f1\Editor"`, made by the Medium launcher;
  the junction lives on V:, nothing is written on C:). The compiler's path string then differs, so the Low run gets its
  own pipe and server. A Low batch Unity started this way compiled a new project (Tundra build success) with a Low server
  (pid 42996, `...\w5347\ueE\Data\DotNetSdkRoslyn\VBCSCompiler.dll`, pipe `mg88s83E...`, not the default `SmFTvM7t...`),
  and no Medium compile could reach it.
- *Also:* the run's own server must end with the run (Roslyn keeps an idle server for its keep-alive, 10 minutes by
  default per Roslyn's source; a guess, not measured here), so the launcher ends the Low servers whose `VBCSCompiler.dll`
  lies under its junction once Unity exits, and the leftovers sweep sees them (item 4 below).
- *Tooling:* a failed `unity-slot run` on Windows now reads its log and the running servers' integrity levels
  (`machine/compilerServer.ts`), and on CS2012 under `Library/Bee` or a Low server running says that a Low-integrity
  compiler server is the likely cause, which pid it is, and that only its own session may end it.

**Options against the target**

| Option | Meets "only the root"? | Admin / C: | Cost and what breaks |
|---|---|---|---|
| B. Dedicated local user (the w5297 design) | no: its profile, ProgramData, Public stay writable | admin; SAM, ProfileList and profile on C: | its own Unity licence, Claude and gh logins, a desktop session for the GPU; blocked by "nothing on C:" |
| **D. Low integrity (trialled)** | yes, except LocalLow and AppDataLow until closed | none for the root; the LocalLow close is one person's icacls on C: | a worker-owned Git copy for msys (`CLAUDE_CODE_GIT_BASH_PATH`), token auth by `extraheader`, profile env vars into the root, leftovers that see Low processes, Steam Input; reading the person's files is still allowed (no-write-up only) |
| E. Write-restricted token from the broker (`CreateRestrictedToken` with `WRITE_RESTRICTED` and a restricting SID granted write on the root) | yes, and no holes: only objects that grant the SID can be written | none (a restricted copy of the caller's own token needs no privilege) | not trialled; needs a small native launcher; named pipes, shared memory and HKCU writes are refused too, so the Unity licence pipe, msys and Unity's EditorPrefs may fail (a guess) |
| F. AppContainer | yes | needs admin `CheckNetIsolation` for loopback; its profile goes under `AppData\Local\Packages` on C: | loopback (the MCP bridge, the portal), the licence pipe and every read path need grants; most work, not trialled |

**Recommendation:** D, behind a setting that is off by default (`worker_integrity: "low"` in `daemon.json`):

1. The install labels the root Low, except `secrets/` and the daemon's own app folder where it sits inside the root, which stay Medium (a worker cannot
   rewrite the daemon's code or its tokens).
2. `launchHost` (`machine/agentHost.ts`) spawns the agent host through a Low-labelled copy of `node.exe` in the root;
   everything the agent starts inherits Low. Editors from `machine/unity.ts` go through the same launcher, and every Low
   Unity (editor or `unity-slot run` batch) starts from a junction in the root to its install's `Editor` folder, never
   the install path itself, so its Roslyn compiler server has its own pipe (w5347, above). Without the junction, one
   Low compile breaks every Medium editor's compiles on the machine.
3. `rootEnv` adds `APPDATA`, `LOCALAPPDATA`, `USERPROFILE` and `TEMP` under the root, `CLAUDE_CODE_GIT_BASH_PATH` to the
   root's own Git copy, and git auth by `extraheader` instead of the shell helper.
4. `machine/leftovers.ts` and the process sweeps learn to see and end Low processes, the Low compiler servers under a
   worker's junction included.
5. Ask each machine's person once to close LocalLow.

Then trial E on one machine as the stricter variant, if the holes or Low's quirks are not acceptable.

**As built (w5377, 2026-11-24).** `daemon.json` `"workerIntegrity": "low"` (set remotely by `machine_update worker_fence`,
4.3), Windows only, off when absent. Where it differs from the plan above:

- `Daemon.lowSetup` (`machine/daemon.ts`) runs once at the daemon's start, in the background; agents start unfenced until
  it finishes, and stay unfenced, with the reason in `logs/daemon.log` (`worker integrity: ...`), if any step fails.
  - It labels the root's folders Low (`machine/lowIntegrity.ts` `lowTargets`, `labelLow`): every child except `daemon`,
    `secrets`, `claude-medium` (w5543), `cache-medium` (w5565), the daemon's own folder and the CI runners' `ffu-runners` (`CI_CHILDREN`, kept Medium: w5440). `repo`, the bare store every sandbox is a worktree of (worker.ts cloneRepo),
    is labelled whole; a `repo` with a working tree gets only its `.git` (lothsahn's "option 1", w5377: the existing
    shared store, labelled and otherwise unchanged). The root itself stays Medium. Outside the root it labels the extra
    roots, the temp and sandbox folders where they are elsewhere, and only what `daemon.json` `workerIntegrityAllow`
    lists, which is the person's decision.
  - Setting a label needs WRITE_OWNER, which an owner lacks by right (it has READ_CONTROL and WRITE_DAC). Where the
    account writes the root only through a group ACE, `icacls /setintegritylevel` answers "Access is denied" (BEAST,
    w5402: `F:fw` inherits `Authenticated Users:(M)` from the drive, and the daemon's token is not elevated, so
    `Administrators:(F)` does not count); every folder failed and the agents ran unfenced (Medium). `labelLow` then grants
    the account `(OI)(CI)F` on that folder and labels it again (measured on BEAST: denied, grant, label, files inside
    inherit Low).
  - What workers write for the daemon is inside the root, so it needs no exception (w5377, lothsahn's rule from w5297:
    "under no circumstances should workers write outside of ffw"): a worker root's Unity slots mailbox is
    `<root>\unity-slots` and its Max events file `<root>\max\max-events.jsonl` (`withRootDefaults`; `daemon.json`'s own
    paths still win). The daemon makes both folders before it labels the root's children, and keeps reading the old
    events file (`<daemon>\max-events.jsonl`, `maxEventsLegacy`) for agents started before the move; such an agent's
    `unity-slot run` finds no arbiter in the old mailbox and runs ungated (`machine/unitySlots.ts` `acquire`).
    `slotsDir()` finds `$FF_WORKER_ROOT/unity-slots` before the pointer, and the daemon sets `FF_UNITY_SLOTS` for all it
    starts. A mailbox still outside the root and not allowed is logged at start.
  - It makes a Low-labelled copy of the SDK's `claude.exe` in `<root>\tools\low` (named by size and mtime) and runs it
    once with `--version` (`probeFence`, 60 s). That copy, not a Low node, is what a sandbox agent runs: the SDK takes
    it as `pathToClaudeCodeExecutable`, and the agent host stays Medium.
  - It junctions each installed Unity's `Editor` folder into `<root>\tools\unity-low\<version>`.
- A sandbox agent's environment (`runSpec`) gets `APPDATA` and `LOCALAPPDATA` under `<root>\home`, the root's Git first on
  `PATH` with `CLAUDE_CODE_GIT_BASH_PATH`, and `FF_UNITY_EDITOR_ROOT` set to the junction folder. The game repo's batch
  scripts start Windows Unity from `$FF_UNITY_EDITOR_ROOT/<version>/Unity.exe` when it is set (FinalFactory #4285).
  `TEMP` and `TMP` were already the session's folder in the root. `USERPROFILE` is left alone.
- **gh at Low** (w5430). gh keeps its login in `%APPDATA%\GitHub CLI` unless `GH_CONFIG_DIR` names a folder. Moving
  `APPDATA` hid that login from every Low worker: "You are not logged into any GitHub hosts", and `ff-pr push` and
  `gh pr create` failed on LothDesktop and BEAST.
  - The daemon sets `GH_CONFIG_DIR` to its own user's gh login (`ghConfigDirFor`, `lowEnv`).
  - For https://github.com, git's helpers become `gh auth git-credential` (`ghLoginCredentialEnv` in `server/launch.ts`).
    Git Credential Manager's `helper-selector` cannot answer at Low: "could not read Username" (measured, w5427).
  - gh reads that folder and the Windows keyring at Low (measured: "Logged in to github.com account Lothsahn (keyring)").
    No token is copied into the environment.
  - At start the daemon runs a Low copy of gh with `auth status`. It logs `worker integrity: gh authenticates for Low
    workers`, or a loud `WARNING gh cannot authenticate`.
  - `ff-pr` checks `gh auth status` before it pushes or merges, and refuses with where gh looked.
- **A Low batch Unity's licence** (w5427). The machine's licensing client, started by a Medium editor, owns
  `\\.\pipe\Unity-LicenseClient-<user>` and the mutex of the same name. No-write-up refuses a Low Unity both:
  "Connection to channel ... refused", "Failed to acquire global mutex", "Licensing initialization failed after 74.82s".
  The game repo's `scripts/unity_licensing.sh` (FinalFactory #4310) adds `-licensingIpc LicenseClient-<user>-low` for a
  Unity under `FF_UNITY_EDITOR_ROOT`, so Unity starts its own Low licensing client. Measured: "Licensing is initialized
  (took 0.13s)".
- The root's Git is PortableGit 2.56.1 at `<root>\tools\git`, pinned by SHA-256 (`server/agentGit.ts`). `worker.ts tools`
  installs it on every Windows rollout and runs its first bash login at Medium: run first at Low, it could not make its
  links (measured).
- The sandbox editors the daemon starts stay Medium. Only what a sandbox agent starts is Low.
- Every 15 s the daemon ends any Low Roslyn compiler server that runs from an install's own path (`strayLowServers`), so
  a worker that starts Unity by its install path cannot break the machine's Medium compiles (w5347).

**What a Low worker meets** (LothDesktop's trial, w5377, 2026-11-24; all measured from a Low agent):
- **Works at Low:**
  - git commit and fetch, and writes into the bare store (#1125);
  - gh with the vault token;
  - `unity-slot run` of a batchmode compile: licence resolved, exit 0;
  - a slot player, windowed, quitting by itself;
  - `ff-leftovers list` and `end`.
- **Refused, as intended:** writes to `%USERPROFILE%`, `C:\ProgramData`, a drive's root, `<root>\secrets` and
  `<root>\tools\node`.
- **The label of an exe sets the integrity of whoever starts it.** Windows starts a Low-labelled exe at Low from any
  parent. Labelling `<root>\tools` made the agents' `node` Low even in Medium agents, and Git's MSYS `sh.exe` started
  from it crashed (`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-…): 0xC0000022`). `labelLow` gives
  `tools\node` an explicit `(OI)(CI)medium`, which beats the inherited Low (#1130). Check any new exe placed under a
  Low folder the same way: `icacls <exe>` shows `Low Mandatory Level:(I)`.
- **CI runners are not workers: their folders stay Medium** (w5440). The first rollout labelled `<root>\ffu-runners`
  Low with the rest. The Listener started before it stayed Medium, but each job's `Runner.Worker.exe` is started from
  the Low-labelled `bin` folder, so every ffu Windows job on BEAST ran at Low from 2026-11-24 12:34Z and its Git Bash died
  before the first step (`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-…): 0xC0000022`). `lowTargets` keeps
  `CI_CHILDREN` out of the Low list and labels them `(OI)(CI)medium` where they were Low; after labelling the daemon
  checks every `<runner>\bin\Runner.Worker.exe` (`lowRunners`) and logs `CI runner job exe ... is still labelled Low`
  if one is. A new runner folder inside the root goes in `CI_CHILDREN`. The game repo's Windows runners are not inside
  any worker root.
- **A Low process sees only Low processes.** tasklist, Get-Process and CIM list about 24 rows: no daemon, and no Medium
  editor or node. Never judge from inside a worker whether a Medium process is running.
- **The firewall cmdlets are denied** (`Get-NetFirewallApplicationFilter`: "Access is denied", PermissionDenied). The
  rules' registry values under `HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules`
  are readable. The game repo's `player_slots.py` reads those instead, because it refused every launch before
  (FinalFactory #4294).
- **A cache that only `--offline` reads stays empty.** The Unity MCP server runs as `uvx --offline` against
  `<root>\cache\uv` (w5281), so no sandbox agent had a bridge until the daemon filled that cache at start (#1131).
  A Low agent's APPDATA is `<root>\home\AppData\Roaming` (`lowEnv`), where uv finds no managed Python, so it takes
  the first one on PATH and resolves the server again. On BEAST that was Python 3.10, which needs packages (tomli)
  the daemon's own warm never fetched, and Low agents still had no bridge (`CONNECTION_CLOSED`). The daemon now fills
  the cache once more under the Low APPDATA when the fence comes on ("its package is in ... for Low agents"; w5402).
- **`AppData\LocalLow` is writable at Low by Windows' design**, so the fence does not stop a player writing there. The
  game's own data goes to `FF_GAME_DATA_DIR` (w5297), but Unity's native writes are not checked.

**Rollout per Windows machine** (effort is a guess)

| Machine | Root | Effort | Risk and what breaks |
|---|---|---|---|
| LothDesktop | `V:\ffw` | half a day after the code lands: label, Git copy, setting on, one editor plus one player plus one agent turn | Steam Input in players; any tool that writes `%USERPROFILE%` directly (not through the env var) is refused and must be moved into the root |
| BEAST | `F:\ffw` | the same, through an ffsb sandbox (the BEAST rule) | the ffsb helpers run outside the root on C: and must stay Medium; check they never run inside a Low worker |
| LothLaptop | its root | the same | laptop power and GPU switching unchanged; the same Steam Input caveat |

Not changed by any of these: the person's own Medium processes, the daemon itself (it stays Medium and launches
workers), firewall rules and the network.

### 4.2 Write lock (Linux, trial; w5333, 2026-11-23)

lothsahn (w5333): "Run all three: Windows on LothDesktop, Linux on biscuit, Mac on m3 or m5". This is the Linux leg,
tried on biscuit (Ubuntu, kernel 7.0.0-38). Off unless a Linux machine's daemon.json says `"writeLock": true`.

**What it does.** `server/launch.ts` starts each agent's claude through `machine/ff-landlock.py`
(`machine/writeLock.ts`, `writeLockSpawner`). The launcher sets up a Landlock ruleset and then runs claude. Landlock is
a kernel LSM that needs no root, no namespace and no unit. Its rules hold for claude and for everything claude starts:
Bash tools, git, gh, `unity-slot run`, batch Unity and slot players. The process cannot lift them. Reads and exec are
not restricted. Writes are allowed only in (`writeLockArgs`):

| Path | Why |
|---|---|
| every child folder of the root except `daemon`, `secrets`, `claude-medium` and `cache-medium` | the work; the Medium agents' Claude folder (w5543, 2.8) and uv cache (w5565), the daemon's folder (or `appDir` if it sits in the root under another name) and the secrets stay read-only. `repo` must stay writable: sandbox worktrees keep their git data in it |
| `extraRoots` | folders of the install that live outside the root |
| `maxEventsFile` and the Unity slots mailbox, only where `daemon.json` puts them outside the root | ffdiscord appends Max's events (`FF_MAX_EVENTS`); the unity-slot mailbox (`FF_UNITY_SLOTS`). A worker root keeps both inside it (`<root>/max`, `<root>/unity-slots`, w5377), so they need no rule |
| `$XDG_RUNTIME_DIR/cc-socks` (sockets only) | Claude Code binds its socket there |
| `~/.config/unity3d`, `~/.local/share/unity3d` | Unity's editor and player prefs, `upm.log` and CoreBusinessMetrics. Moving them with XDG_CONFIG_HOME would also hide the licence from Unity |
| `/tmp` | Unity ignores TMPDIR for its Package Manager socket (`/tmp/Unity-Upm-<pid>.sock`: without it the editor exits 1), its shader compiler's lock (`/tmp/Unity-ShaderCompilerIPC-*.lock`) and `/tmp/.dotnet/shm` (without them it aborts at shader compiler start). |
| `/dev`, `/proc` | null, tty, shm and the GPU; Unity writes its own `oom_score_adj`. Ordinary file modes still apply |
| `writeLockExtra` | anything else a machine needs, each with its reason |

**Why not systemd.** w5297 picked `systemd-run --user` with ProtectSystem=strict, ProtectHome=read-only and
ReadWritePaths. On biscuit that unit starts but **does nothing**: every write still succeeded (home, /tmp, a stand-in
daemon folder). Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1`. systemd-executor creates the user
namespace, then the kernel logs AppArmor `DENIED capable sys_admin` (profile `unprivileged_userns`) for its mount
namespace. The user manager runs the command anyway, without the protection. Two more problems: the daemon starts agents
with `--scope`, and a scope takes no sandboxing properties at all. Making systemd work needs root: an AppArmor profile
for systemd-executor, or turning the sysctl off for the whole machine.

**Trial results** (measured on biscuit, w5333; output in that request's report):

| Check | Result |
|---|---|
| A write outside the root (home, `~/.config`, `/tmp`, `/var/tmp`) | refused |
| The daemon's folder and `secrets` (write, new file, rename of the folder) | refused, tested on stand-in folders |
| git (fetch, status, clone, commit in the root) and gh by token (`gh api user`) | pass |
| Claude Code's startup under the lock | passes once `cc-socks` is granted. A full turn was not run: a worker's shell has no Claude login |
| Headless slot player (`player_slots.py launch ... -batchmode -nographics -ffSoloQuitAfterSeconds 60`) | pass, clean quit |
| Unity licence seat | pass: the editor reached the running LicenseClient and resolved the entitlement |
| Headless editor (`-batchmode -nographics -quit` on a sandbox project) and its batch player build (`build_player.sh ... linux`) | pass, once `/tmp` is writable: exit 0, licence resolved, no refused write left |

**Limits.**
- A new top-level folder in the root is refused, because rules name the folders that exist when claude starts. A
  folder the daemon adds later is picked up at the next start.
- The agent host and the sandbox editor the daemon starts stay outside the lock.
- `/tmp` and `/dev/shm` are writable, and the worker runs as the person, so it can change or delete the person's own
  files there (not other users'). A private `/tmp` needs a mount namespace, refused here like systemd's.
- Refused writes leave no log on a machine without auditd. Find them with `strace -f -Z`.
- Needs Landlock (on in Ubuntu since 22.04). Without it the launcher exits 125 and the agent does not start: leave the
  setting off there.

### 4.3 Turning a fence off, and why recovery never runs inside one (w5377, 2026-11-24)

lothsahn (w5377): "If we turn on the fences, is there some emergency way we could reinstall the system if things go
wrong?" Yes. A fence wraps only a sandbox agent's claude and what it starts. Everything that repairs a machine runs
outside it: the daemon, the agent host, the in-process FF Factory tools, the machine agent's link and its update job
(`scripts/worker/linkJob.ts`), the installer (`scripts/worker/install.ps1`, `install.sh`, `worker.ts update`) and an
ssh session. A fenced worker breaking cannot stop any of them.

**The one setting per OS** (daemon.json in the daemon's folder; the daemon reads it when it starts):

| OS | Fence | On | Off |
|---|---|---|---|
| macOS | Seatbelt (`server/workerFence.ts`, docs/worker-fence.md) | `"workerFence": "seatbelt"` | key absent |
| Linux | Landlock (`machine/writeLock.ts`, 4.2) | `"writeLock": true` (`writeLockExtra` is kept either way) | key absent |
| Windows | Low integrity (4.1) | `"workerIntegrity": "low"` | key absent |

**Off from the portal, nobody at the machine (the normal route).** The orchestrator or ops worker runs
`ops_worker machine_update` with `machine: <id>` and `worker_fence: "off"` (or `"on"`). It goes the machine update's
usual way: over the machine agent's link as `self_update` with the flag (`server/machines.ts` `linkUpdate`), or, when
the link is down, by ssh as `install.ps1 -Update -WorkerFence off` on Windows and `install.sh --update --worker-fence
off` on Mac and Linux (`server/opsWorker.ts` `machineInstall`). Either way `worker.ts update` (`planUpdate`) removes or
sets this OS's key in daemon.json, carries every other key, and restarts the daemon, which starts its next agents
without the fence. An update stops only the daemon: running agents stay in their agent hosts and keep the fence state they started
with (docs/worker-install.md, "An update does not stop running work"); the change holds for every agent started
after it.

**By hand, if the portal cannot reach the machine at all.** From any shell on it (ssh, or a person at the desk):

- Re-run the installer's update with the same flag the portal's ssh route sends: `install.ps1 -Update -WorkerFence off`
  on Windows, `install.sh --update --worker-fence off` on Mac and Linux (worker-install.md says where the install's
  scripts are and how to run them).
- Or delete this OS's key from the daemon's `daemon.json` and restart the daemon's service (the scheduled task on
  Windows, the systemd user unit on Linux, the LaunchAgent on a Mac; the installer made it). On Windows the Low labels
  left on the root's folders need no undoing: they only stop Low processes writing up, and Medium ones are unaffected.

**The fallback when a fence cannot apply** (`machine/fenceProbe.ts`). Before the daemon puts its first sandbox agent
inside a fence, it runs a no-op inside the same fence once (Mac: `sandbox-exec -p <profile> /usr/bin/true`; Linux:
`python3 ff-landlock.py <rules> -- /bin/true`; Windows: the Low copy of claude with `--version`, after its folders are
labelled, 4.1 "As built"). If that does not exit 0 within 15 s (60 s on Windows) (a kernel without Landlock, a profile
the kernel refuses, python3 missing, a folder that could not be labelled), the daemon logs
`worker fence: ... could not run a no-op (...); agents run unfenced` (or `write lock: ...`) and runs its agents
unfenced. Nothing in the fence code can throw out of the daemon's start or an agent's spawn: the fence never fails
the daemon, it fails open to the pre-fence behaviour and says so in `logs/daemon.log`. The daemon itself never runs
inside a fence, so a fence change cannot stop it starting.

**What a code rollback does not undo.** The link update rolls back the code when a new daemon does not come up
(`linkJob.ts` `putBack`), but it does not revert daemon.json. That is intended: a bad fence does not stop the daemon
(the fallback above), so a daemon that fails after an update failed for another reason, and the fence setting stays
as the update set it.

## 5. Migration

### 5.1 Per machine

Common to all, in order (w513's tool: `migrate --dry-run`, then `migrate`, then a separate `migrate --cleanup`):

1. **Dry run.** List every source in section 1 that exists, its size, its target, and the free space each step needs.
   Refuse if a sandbox has an agent mid-turn or a running editor; those are re-checked per sandbox at its turn.
2. **Install the root beside today's layout** (section 3, steps 1-6). Nothing old is touched.
3. **Copy what is small or on another volume** (the daemon's state, standing agents' folders, `~/.claude` into
   `claude/`, configs into `secrets/` and `home/`). Verify each by file count and hashes. Keeping
   `~/.claude/projects` is what lets a worker resume its conversation (beast-machine.md "Migration": "same
   `CLAUDE_CONFIG_DIR`").
4. **Move what is large and on the same volume, by rename.** A copy cannot work on BEAST: `F:` has 213 GB free, and
   the six sandboxes hold 532 GB (15 to 124 GB each), with Libraries of 43 to 99 GB (measured). A rename on the same volume is instant and is
   undone by renaming back. Per sandbox, while idle:
   1. Fetch its branch from the old base into `repo/`.
   2. `git -C <root>/repo worktree add --no-checkout <tmp> <branch>`, to get the admin folder.
   3. Rename the sandbox folder into `sandboxes/<name>`, keep its old `.git` file as `.git.pre-ffw`, and write the new
      one.
   4. Reset the index to HEAD.
   5. Re-apply the staged part from a patch saved before the move. Staged blobs that were never committed exist only
      in the old repository, so the patch carries them.

   Verify `git status --porcelain=v2`, `git diff` and `git diff --cached` are the same as before. The daemon `adopt`s
   it (protocol 6, `machine/sandboxes.ts:468-489`; its "worktree of the main clone" check points at `repo/`). The
   folder name, and so the Unity instance name, is unchanged; the project path changes, so the one-time script reimport
   runs at the next editor start.
5. **Switch the daemon**: redeploy with the root (its `daemon.json` path, the env block), then `list_sandboxes`,
   `unity status` and one worker started in a moved sandbox.
6. **Watch a day.** Then `--cleanup` removes the old copies, the old player slots and their firewall rules, the old
   task, `%ProgramData%\FinalFactory\player-slots.json`, and `.git.pre-ffw` files, each listed first.

**Rollback** at any step before cleanup: redeploy the daemon with its old `daemon.json` (kept as
`daemon.json.pre-ffw`), and for each moved sandbox rename it back and restore `.git.pre-ffw`. The old base still holds
its admin entry, which step 4 never removed. Everything copied was a copy.

**BEAST** (root `F:\ffw`, anchor `C:\ffw-anchor`):

- Order: after the portal has left BEAST for the VM (w499 done; `convert_machine beast to: "ssh"`) and after w510's
  removal of the portal's host code, so only the daemon owns `F:\ffsb`.
- Moves by rename on `F:`: the six sandboxes (`F:\ffsb\<name>` → `F:\ffw\sandboxes\<name>`), `_seed` → `seed`,
  `_agents` → `agents` (standing agents move to a machine under D16), `_nightly-e2e` → `nightly`, the old pool beside `F:\ffsb` →
  `players` (new firewall rules for the new paths, the old group removed at cleanup).
- Scratch: `_scratch` (141 GB), `F:\ffsb-scratch` (13 GB), `F:\tmp`, `_research`, `_w94` → `scratch/` by rename; the
  sizes say a clean-up pass is worth doing first (decision 10).
- Copies to `C:\ffw-anchor`: the daemon folder (`C:\Users\rydin\.ff-factory`, protected: the migration runs as the
  installer, not an agent).
- Stays: `C:\ffsb\_base` (Ben's clone). Its 14 worktree entries become stale. `git worktree prune --dry-run` there
  lists them, and pruning is Ben's call, since the clone is his. `~/ff-worker` (11 GB) and the four ad-hoc tasks are
  not migrated (decision 10). The `ffsb-*` portal tasks leave with w510. The mode2 runner is decision 8.
- Game-repo references to update in the same change: `scripts/nightly/install_schedule.sh:25-27`,
  `nightly.sh:25`, `lab.m3.json:10`, `player_slots.py:69-79`, `setup_player_slot_firewall.ps1:34-46` (S).

**LothDesktop** (root `D:\work\ffw`; not seen by me: from `list_machines` and docs/machines.md):

- Install with `--reference-if-able` the person's clone and its Library as the seed (both read-only). *(That clone is gone since 2026-10-10.)*
- Rename `D:\work\ffsb\<name>` → `D:\work\ffw\sandboxes\<name>` (same volume, as listed), with the git re-home of step
  4: those were worktrees of the person's clone, so the re-home is what removed it from the
  install.
- Move the old slot pool → `players`, `D:\work\.ff-factory` → `daemon` (state) and `agents`, and the old nightly lab
  → `nightly` (by rename; the lab's own clone moves with it).
- Copy into `secrets/`: the ffbox and ffdiscord configs.
- After: the person's clone was lothsahn's alone; it and the old slot pool and nightly lab are gone (2026-10-10). Its `worktrees/` entries for the moved sandboxes were pruned with his
  OK.

**The M3 and the M5** (root `/Users/Shared/ffw`; not seen: from `list_machines` and the skills):

- Today they run agents in the person's clone (`~/nevergames/FinalFactory`), with no sandboxes.
- The install gives them a pool for the first time: `repo/` with `--reference-if-able ~/nevergames/FinalFactory`, the
  seed by APFS clone (`cp -c`) of that clone's Library, `max_sandboxes` from their RAM.
- Copy `~/.ff-factory` state and `~/.claude` (the machine login stays in the keychain; portal-run agents use a vault token and do not read it), and on
  the M3 the nightly lab (outside the install folder, gone since 2026-10-10) → `nightly/` by rename (same volume).
- The old slot pool → `players/` (gone since 2026-10-10).
- `~/nevergames/ff-audit-artifacts` stays the person's.
- The M5's `~/.steamcmd-home` stays: last-resort releases are a person's job, not a worker's.
- Disk space is unknown to me; the dry run reports it.

### 5.2 Code changes

| # | Change | Where | Size |
|---|---|---|---|
| 1 | The root as the daemon's one setting: `root.json`, derived defaults for `app_dir`, `sandbox_root`, `temp_dir`, the seed, slots, nightly, agents; the machine record and `list_machines` show the root | `machine/daemon.ts:43-90,123-126`, `shared/types.ts`, `server/machines.ts:69-113,733-793`, `server/machineDeploy*.ts` | M |
| 2 | The env block in `run-daemon.ps1` and the plist | `server/machineDeployWin.ts:354-470`, `server/machineDeploy.ts:187-190` | S |
| 3 | `repo/` as a bare clone; the pool's git against it; the seed as the Library source | `machine/sandboxes.ts:107-117,162-172,325-329,468-489` | M |
| 4 | Remove the main-clone code (2.3 list). Done (w536): the portal and the guard, the daemon's start check (no worker outside a sandbox, `max_agents` gone, one agent cap), and the daemon's main-clone editor, watch, MCP place, slot place, git status, branch switch, stale-output place and image gallery | `machine/daemon.ts`, `machine/unityMcp.ts`, `server/guard.ts`, `server/machines.ts`, `server/standing.ts`, `server/placement.ts`, `server/agents.ts` | M |
| 5 | `unityMcpServer` written at install; `.claude.json` read from `CLAUDE_CONFIG_DIR` | `machine/unityMcp.ts:29-41` | S |
| 6 | The token out of `daemon.json` into `secrets/`; `patchDaemonConfig` unchanged otherwise | `machine/daemon.ts:113,1229`, `server/machineDeploy.ts:416` | S |
| 7 | Guards: protected paths and secrets from the root (`daemon/`, `secrets/`, `claude/`) instead of the `.ff-factory` spellings; the player-path rule (2.5) | `server/guard.ts`, `server/secretGuard.ts:167-177` | S-M |
| 8 | Clean-up roots from the root, not `HOME` (`machine/daemon.ts:277,292,298`); nightly roots from `FF_NIGHTLY_ROOT`, not a hard-coded default (`server/staleOutput.ts`; the hard-coded places are gone, 2026-10-10) | as listed | S |
| 9 | Installers and uninstallers, per OS | `scripts/install-worker.ps1`, `scripts/install-worker.sh` (new) | L |
| 10 | The migration tool (dry run, copy or rename, git re-home, verify, rollback, cleanup) | `scripts/worker-migrate.ts` (new) | L |
| 11 | Game repo: slot root and nightly root from env only; `lab.py` and `slot_path` refuse instead of falling back; BEAST paths in the nightly scripts | `scripts/nightly/*` (2.5, 5.1) | S. Done 2026-10-10 (w897) |
| 12 | Skills: determinism-audit and the BEAST-sandbox recipe use the slot pool; paths that name `F:\ffsb` or `~/.ff-factory` take the root | ff-agents, through `/ff-agents:publish-skills` | S |
| 13 | Optional: a game-side override of the data folder on Windows | game repo, decision 5 | M |

**Overlap with w510** (worker 6db46872): w510 removes the portal's host code, `server/sandboxes.ts` (`SandboxManager`)
and the host-only branches in `server/agents.ts` and `server/index.ts` (beast-machine.md, "Deleting it … is the
follow-up"). It also turns the portal-config settings BEAST's daemon inherits (`localMachineDefaults`,
`server/machines.ts:97-113`: `repo.basePath`, `sandboxRoot`, `librarySeed`) into an ordinary machine's settings. Changes
1, 4 and 7 touch the same files. The order that avoids two people rewriting them: w510's removal merges first. w513
starts meanwhile with what does not overlap (9, 10, 2, 5, 6, 11, 12), then does 1, 3, 4, 7 and 8 on top of w510. The
`local` machine concept (`Machine.local`) is w510's to keep or drop, since it disappears with the portal leaving BEAST.

## Open decisions for lothsahn

Each with a recommendation and what it rests on.

1. **The root's location.** BEAST `F:\ffw` with `C:\ffw-anchor` for `daemon/`, `secrets/` and `logs/`; LothDesktop
   `D:\work\ffw`; the Macs `/Users/Shared/ffw`.
   - *Measured:* BEAST's `F:` is the Dev Drive the sandboxes, seed and slots share.
   - *Sourced:* the daemon remounts it (w466).
   - *Guess:* LothDesktop's volumes, from `list_machines`.
2. **Containment.** The person's account with the root now; a dedicated user as an experiment later (section 4).
   - *Measured:* the daemon needs the interactive session for the GPU and the login (`server/machineDeployWin.ts:389-441`).
   - *Guess:* whether Unity renders in a background session, which the experiment settles.
3. **No `HOME`/`USERPROFILE` override; targeted variables instead** (2.4).
   - *Measured:* gh's token is in the OS keyring and git uses gh as its helper on BEAST.
   - *Sourced:* each variable's docs.
   - *Guess:* how each tool behaves under an overridden profile.
4. **gh credentials for workers.** A fine-grained token per machine in `secrets/gh-token`, scoped to the Final-Factory
   repos, in place of the person's keyring login (BEAST's workers act as `bryding` today, measured with
   `gh auth status`). Whose account owns it is the open part: Ben's or a bot account.
   - *Sourced:* gh honours `GH_TOKEN`.
5. **The game's data folder on Windows.** Leave it outside the root for w513 (listed and cleaned), and file a separate
   request for a data-root override in the game.
   - *Measured:* it is 8.9 GB on BEAST, shared with the person's own play, and 48 uses read
     `Application.persistentDataPath` directly. That is an M change with save paths in it.
6. **Slot names.** Keep `slot0..slotN-1/player/finalfactory.exe` (today's code and rules) rather than `slot1..N`.
   - *Measured:* `player_slots.py:102-105`, and the 16 existing slot rules.
   - Either works; renaming costs a test change and new rules.
7. **Firewall prompts off** (`NotifyOnListen False`) on worker machines. Yes on LothDesktop if you agree. On BEAST
   only with Ben's OK: it is his PC and the setting is machine-wide.
   - *Sourced:* NetSecurity docs.
8. **BEAST's mode2 CI runner.** Put it under the slots (`FF_PLAYER_SLOTS=on`, `FF_PLAYER_SLOT_ROOT` in the runner's
   service environment).
   - *Measured:* it made 58 of the 382 rules, and `player_slots.py:94-98` turns the pool off on runners.
   - It is outside the worker install, so it needs your call or Ben's.
9. **How sandboxes migrate.** Re-home in place by rename on the same volume (5.1 step 4), not by copy.
   - *Measured:* 213 GB free on `F:` against 532 GB of sandboxes (15 to 124 GB each).
10. **Legacy and scratch on BEAST.** Archive then delete `~/ff-worker` (11 GB) and the four ad-hoc scheduled tasks
    (one runs Unity elevated). Review `F:\ffsb\_scratch` (141 GB) before moving it. Ben's call: it is his machine and
    his runs.
    - *Measured:* sizes and tasks.
11. **Seeding the clone from a person's clone** (`--reference-if-able … --dissociate`, plus a read-only copy of the LFS
    objects) instead of a fresh 10 GB fetch.
    - *Sourced:* git-clone docs.
    - *Measured:* sizes on BEAST.
    - *Guess:* the fetch time it saves.
12. **Git 2.48+ on every machine**, for relative worktree paths, so a root can be renamed.
    - *Measured:* BEAST has 2.45.1.
    - *Sourced:* Git 2.48 release notes.
    - Without it, absolute paths and `git worktree repair` after any move.
