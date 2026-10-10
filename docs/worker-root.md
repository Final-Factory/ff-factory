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
| `logs/` (`daemon.log`, `daemon.err.log`, `supervisor.log`, `*.prev`) | daemon output | daemon, supervisor | M | redacted | `server/machineDeployWin.ts:357`, `server/machines.ts:1678` |
| `sandboxes.json` | the sandbox pool across restarts | daemon | M | no | `machine/daemon.ts:241` |
| `cleanup.json`, `cleanup-log.jsonl`, `cleanup-state.json` | clean-up settings and log | daemon | M | no | `machine/daemon.ts:136,270`; `server/cleanup.ts:537-569` |
| `outside-watch.json` | the outside watchdog's ntfy topic | daemon | M | **yes** (the topic is the credential) | `machine/daemon.ts:960-969` |
| `public-identity.gitconfig` | the Final Factory identity for public repos (`GIT_CONFIG_*`) | daemon (`FF_APP_DIR`) | M | no | `server/launch.ts:121-125`, `machine/daemon.ts:1234` |
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
| `C:\ffsb\_base` (BEAST), `D:\work\FFFRepo` (LothDesktop), `~/nevergames/FinalFactory` (Macs) | `repoPath`: the base the sandboxes are worktrees of, and main-clone agents' folder | the person | M | git objects 1.3 GB and LFS store 8.4 GB measured on `_base` (14 worktree entries registered in it) | no | `machine/daemon.ts:48`; probe `server/machineDeploy.ts:110,319`, `machineDeployWin.ts:281-284` |
| `ff-local-backups/<time>/` beside the clone | the backup-before-discard rule for a person's uncommitted work | workers (guard-enforced) | M | not seen | no | `server/guard.ts:54-56,151,167-191`; `server/agents.ts:1523`; ff-agents `project-memory/memories/feedback-back-up-then-clear-bens-clone.md:21` |

### 1.5 Players, nightly lab and legacy labs

| Path | For | Created by | Scope | BEAST size | Secret | Code |
|---|---|---|---|---|---|---|
| player slot pool: `F:\ff-players`, `D:\work\ff-players`, `~/nevergames/ff-players`; `<root>/slotK/player/`, `slot.json`, `leases/`, `pool.lock` | fixed exe paths for the firewall (w350) | `player_slots.py`, the firewall script | M | 13 GB | no | `scripts/nightly/player_slots.py:69-89,102-105`; `setup_player_slot_firewall.ps1:29-46` |
| `%ProgramData%\FinalFactory\player-slots.json`, `~/.config/finalfactory/player-slots.json` | the recorded slot root and count | firewall script | M | tiny | no | `player_slots.py:54-58` |
| nightly lab `FF_NIGHTLY_ROOT`: `D:\work\ff-nightly` (Windows), `~/nevergames/ff-nightly` (Mac): own clone, `builds/<sha>-*`, `runs/`, `logs/`, `reports/`, `tmp/` | the nightly e2e | nightly scripts | M | not on BEAST | no | `scripts/nightly/nightly.sh:17-18,23-34`; `install_schedule.sh:31,46-54`; `make_overlay.py:78`; ff-factory `server/staleOutput.ts:72-73` (hard-coded default) |
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
| `~/.claude-worker-token` (BEAST) | a token file (config `claudeTokenFile`) | a person | M | tiny | **yes** | `server/config.ts:195`, `server/appConfig.ts:312-315` |
| `~/final-factory-agents/` | the marketplace clone `registerAgents.sh` installs from | a person | M | 3.8 MB | no | CLAUDE.md of the game repo |
| `~/.local/bin/` (`claude.exe`, the `unity` CLI shim) | Claude Code's native binary; the editor-ops fallback | installers | M | 236 MB | no | `server/machineDeployWin.ts:269,354`; ff-agents `editor-ops/references/recovery.md:193` |
| `~/.gitconfig` | user git config; on BEAST its GitHub credential helper is `gh auth git-credential` (measured) | a person | M | tiny | no | — |
| gh's token: Windows Credential Manager (BEAST: "keyring", measured), `~/.config/gh` on a Mac, `%APPDATA%\GitHub CLI` | GitHub API and git pushes | `gh auth login` | M | — | **yes** | `server/secretGuard.ts:173-176` |
| `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (78 on BEAST, measured) | the public-repo identity, per worker | daemon | A | — | no | `server/launch.ts:121-125` |
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
- **LothDesktop.** Everything on `D:` (the daemon folder, sandboxes and slots are all there today, from
  `list_machines`), so `D:\work\ffw` has no junctions.
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
clones (`D:\work\FFFRepo`, the Macs' `~/nevergames/FinalFactory`, Ben's `C:\ffsb\_base`) are outside the install
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
  `D:\work\FFFRepo\Library` (docs/machines.md "Warm Library"). Its installer copies that Library once, read-only, into
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
| `CLAUDE_CONFIG_DIR` | `claude/` | settings, plugins (`registerAgents.sh` run with it set), `projects/` (transcripts, memory, resume), credentials on Windows | sourced: Claude Code settings docs; `server/usage.ts:195` already follows it |
| `TEMP`, `TMP`, `TMPDIR` | `tmp/` (the existing `temp_dir`) | agents' temp, Claude's task output | measured: today's mechanism, `machine/daemon.ts:58,126` |
| `GIT_CONFIG_GLOBAL` | `home/.gitconfig` | identity, credential helper | sourced: git-config docs (git 2.32+) |
| `GH_CONFIG_DIR` + `GH_TOKEN` | `home/.config/gh`, `secrets/gh-token` | gh's config; the token in place of the OS keyring, where BEAST's lives today (measured) | sourced: `gh help environment` |
| `GIT_SSH_COMMAND` | `ssh -F <root>/home/.ssh/config -i <root>/secrets/ssh/id_ed25519` | git over ssh | sourced: git docs |
| `UPM_CACHE_ROOT` | `cache/upm` | Unity's global package cache | sourced: Unity manual, "Customize the global cache location" |
| `npm_config_cache`, `PIP_CACHE_DIR` | `cache/npm`, `cache/pip` | tool caches | sourced: npm and pip docs |
| `FF_PLAYER_SLOT_ROOT`, `FF_PLAYER_SLOT_COUNT` | `players/`, 8 | the slot pool; ends the drive-letter probing in `default_root()` (`player_slots.py:69-79`), which already left BEAST with rules for both `D:\work\ff-players` and `F:\ff-players` (measured) | measured: `player_slots.py:83-87` |
| `FF_NIGHTLY_ROOT` | `nightly/` | the nightly lab | measured: `nightly.sh:17-18` |
| `FFDISCORD_HOME` | `secrets/ffdiscord` | the Max bot config, where scripts honour it | measured: `nightly.sh:43`; whether the `ffdiscord` CLI itself does is unverified |
| `FF_MAX_EVENTS`, `FF_UNITY_SLOTS` | `daemon/…` | already set by the daemon from `app_dir`. The Unity slots mailbox stays at its standard place in the home folder (not under the root), where scripts outside the daemon (the nightly harness, a build by hand) find it with no config (w469) | measured: `machine/daemon.ts:713,882`; `machine/unitySlots.ts` `slotsDir` |
| `CFFIXED_USER_HOME` (Mac only, for players) | `home/` | a Mac player's `persistentDataPath` | measured: in use by `lab.py:28-34` |

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
   needed when the machine's workers run on the portal's token (`machines.useHostClaudeEnv`, default true,
   docs/machines.md "Claude account"). A machine on its own login runs `claude` once with the variable set.
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
  `_agents` → `agents` (standing agents move to a machine under D16), `_nightly-e2e` → `nightly`, `F:\ff-players` →
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

- Install with `--reference-if-able D:\work\FFFRepo` and its Library as the seed (both read-only).
- Rename `D:\work\ffsb\<name>` → `D:\work\ffw\sandboxes\<name>` (same volume, as listed), with the git re-home of step
  4: today these are worktrees of `D:\work\FFFRepo`, so the re-home is what removes the person's clone from the
  install.
- Move `D:\work\ff-players` → `players`, `D:\work\.ff-factory` → `daemon` (state) and `agents`, and `D:\work\ff-nightly`
  → `nightly` (by rename; the lab's own clone moves with it).
- Copy into `secrets/`: the ffbox and ffdiscord configs.
- After: `D:\work\FFFRepo` is lothsahn's alone. Its `worktrees/` entries for the moved sandboxes are pruned with his
  OK.

**The M3 and the M5** (root `/Users/Shared/ffw`; not seen: from `list_machines` and the skills):

- Today they run agents in the person's clone (`~/nevergames/FinalFactory`), with no sandboxes.
- The install gives them a pool for the first time: `repo/` with `--reference-if-able ~/nevergames/FinalFactory`, the
  seed by APFS clone (`cp -c`) of that clone's Library, `max_sandboxes` from their RAM.
- Copy `~/.ff-factory` state and `~/.claude` (the machine login stays in the keychain, or the portal's token), and on
  the M3 the nightly lab `~/nevergames/ff-nightly` → `nightly/` by rename (same volume).
- `~/nevergames/ff-players` → `players/`.
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
| 8 | Clean-up roots from the root, not `HOME` (`machine/daemon.ts:277,292,298`); nightly roots from `FF_NIGHTLY_ROOT`, not the hard-coded `D:/work/ff-nightly` (`server/staleOutput.ts:72-73`) | as listed | S |
| 9 | Installers and uninstallers, per OS | `scripts/install-worker.ps1`, `scripts/install-worker.sh` (new) | L |
| 10 | The migration tool (dry run, copy or rename, git re-home, verify, rollback, cleanup) | `scripts/worker-migrate.ts` (new) | L |
| 11 | Game repo: slot root and nightly root from env only; `lab.py` and `slot_path` refuse instead of falling back; BEAST paths in the nightly scripts | `scripts/nightly/*` (2.5, 5.1) | S |
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
