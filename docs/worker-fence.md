# The worker write fence (macOS, w5333 trial)

lothsahn (w5333): "Regardless of user the workers should only write to the v: on windows. Ideally they'd only be allowed
to do that." On a Mac the worker root is `~/ffw` (docs/worker-root.md), so the fence is: a sandbox agent writes only in
`~/ffw`, and every other write is refused by the kernel.

**Off by default.** `"workerFence": "seatbelt"` in a Mac's daemon.json turns it on for that machine's sandbox agents (the
daemon reads it at start; check it after a redeploy rewrites daemon.json). On another OS, with no `root`, or without
`/usr/bin/sandbox-exec`, the setting logs one line and agents run unfenced.

## What protects a machine, and what does not (w5556, from the w5451 audit)

**The text guard is not protection.** `server/guard.ts` (and `standingGuard.ts`, `secretGuard.ts`, `privacyGuard.ts` and the
other guards it calls) match only the text of a command or tool call. They catch the careless mistakes of a well-meaning
worker: a force push, killing the wrong editor, a delete outside the install folder. A script file gets past them
(`guard.ts:30-34` says so), and so do `execute_code` in the worker's own editor and a junction. They do not stop a determined
or hijacked worker (prompt injection through a Discord message, an issue or a web page), and no doc or prompt may call them a
sandbox, a boundary or protection.

**The real protection is three things the worker cannot edit around:**

1. **The OS write fences** (this page and docs/worker-root.md section 4): Windows Low integrity, macOS Seatbelt, Linux
   Landlock. The daemon, the agent host and its hooks stay outside them.
2. **The read blocks**: what a fenced worker may not read (secrets, the daemon's folder, the machine's gh login and the
   Keychain). Today the fences are write-only, so these are not closed yet (below).
3. **Daemon-side checks**: the daemon and the portal verify what a worker asks for (a machine's session report sets only run
   state, machine updates install exactly the verified commit, the evidence check runs a file only the daemon wrote).

**What each fence covers today** (sourced from the w5451 audit, whose Windows findings were measured on BEAST and whose Mac and
Linux findings are sourced, not yet probed on a live fenced worker; the probe legs are w5462 m5/m3, w5463 biscuit, w5464
LothDesktop):

| | Covers | Does not cover |
|---|---|---|
| Windows Low integrity | writes outside the root, registry under HKCU\Software, scheduled tasks, shutdown (measured on BEAST); writes to `daemon`, `secrets`, `ffu-runners`, `tools\node`, `tools` itself (w5717; its other folders stay Low) | reads of anything, including `secrets\`; writes to every other sandbox, instance portals, `claude\` and players inside the root; signalling or injecting into other Low workers' processes; the network; code that runs above the fence (the instances updater task, a Medium editor, the daemon's `git status`) |
| macOS Seatbelt | file writes outside the root; other conversations' transcripts in the root's Claude home (w5563, docs/transcript-seal.md); with the read fence `on`: reads of `~/.ssh`, browsers, `~/.config/gh` and the Keychain, Keychain services and preference writes (w5553, w5560, "Owner secrets" below); preference writes also with `workerPrefFence` (w5659) | with the read fence off: those reads; preference writes through cfprefsd unless `workerPrefFence`; signals to other processes of the user; other sandboxes inside the root; the network |
| Linux Landlock | file writes outside the root; with `transcriptLock` on, other conversations' transcripts (w5702, docs/transcript-seal.md) | reads; signals; other sandboxes inside the root; the network; the systemd user bus (`systemd-run --user`, guess) |
| Any OS | | a worker is not walled off from other workers' sandboxes inside the root (w5451 items 7 and 8) |

**Resource caps** are not a fence, but they bound what one worker can use: memory, processes and temp disk per worker
(w5554, docs/worker-caps.md, with the ways a hijacked worker can still escape them). They start in warn mode, which measures
and reports and stops nothing: `ops_worker machine_update worker_caps off` is the switch, as `worker_fence off` is the
fence's, and enforce waits on a week of warn data and the owner's go.

**Fixes, by state** (a fix is "merged" only when its PR has merged; everything else is in progress):

- Merged: standing-agent shell guard refuses the w5452 bypass forms (w5504, #1150); standing agents' git ignores repo-config
  programs (w5514, #1152); root-owned releases and an activation that verifies commit, clean tree and path (w5505, #1149);
  a machine's session report sets only run state (w5515, #1155); machine updates install exactly the verified commit
  (w5516, #1161).
- In progress, PR open: label Low only the root folders workers write (w5539, #1166); fenced workers signal only their own
  processes, and the Linux lock refuses the systemd user bus (w5562, #1168); the evidence check runs only a
  `pr_evidence.py` workers cannot have written (w5542, #1171); no process the portal starts can read the vault key
  (w5506, #1154).
- Players the daemon starts run fenced on Linux and macOS (w5564, below).
- In progress, no PR yet: workers cannot read the secrets and daemon folders on any OS (w5546); the fence fails closed with a
  portal alert (w5555); the gh-config and Keychain read deny (w5548). Until they land, treat every item in the "does not
  cover" column as open.

## Players the daemon starts (w5564, w5451 item 33)

A timed run's player (`machine/timedRunner.ts`, `leg()`) is a file in a folder fenced workers write (`players/slotK-n/player`,
`timing/builds`), and the daemon starts it. Before w5564 it ran as the daemon's plain child, so a swapped player wrote
anywhere the user could. Now `machine/playerFence.ts` wraps it on Linux and macOS, whatever the worker fence setting:

- **Writable**: the leg's run folder, the player's own build folder, the game's data root (`FF_GAME_DATA_DIR`, saves) and the
  player home (`FF_PLAYER_HOME`), each only if it lies inside the worker root, is not the root itself and is not under
  `daemon` or `secrets` (`playerWritable`). Nothing else: not `/tmp`, not the home folder, not other slots or sandboxes.
- **Linux**: `ff-landlock.py --rw /dev --rw /proc --rw <each>` (files only; the network is untouched, so pair runs work).
  `/dev` stays writable for the GPU and `/dev/shm` (tmpfs, gone at reboot).
- **macOS**: `sandbox-exec -p` with `(allow default) (deny file-write*)`, then the device nodes, the user's Darwin temp and
  cache folders (`getconf DARWIN_USER_TEMP_DIR`/`DARWIN_USER_CACHE_DIR`) and each writable folder.
- **Fails closed**: the fence is probed once (a no-op inside it, `fenceProbe.ts`); if the wrapper is missing or the no-op
  fails, every leg is refused with the reason and no player starts. Windows players are unchanged (Low integrity comes
  from the folder labels, w5539). `launch.txt` in each leg's folder names the fence it ran under.
- **Measured on biscuit, 2026-11-25** (Linux, 1280x720 under Xvfb, w1440 life save, 2 interleaved rounds per side, both
  sides already under the worker's Landlock, so the delta is the player's own layer): fenced 117.1 and 109.5 fps, unfenced
  113.1 and 117.1 fps; frame average 8.54/9.13 ms against 8.83/8.53 ms. The spread between rounds of one side (7.6 fps)
  is wider than the gap between the sides (1.9 fps): no cost seen. The save loaded in every leg. A write to `/tmp` (which the
  worker shell itself could write), the home folder, `ffw/tmp`, `ffw/sandboxes/slot1` and another player slot was refused.
- The player writes `.ff-local-automation-status.json` (and `.tmp<guid>` copies) beside its own exe on every leg. w5574's
  per-leg check (`buildProblem`) refused any file that is not the build's, so every leg after the first was refused; the
  runner now drops those status files before the check (`dropPlayerStatus`), and any other extra file is still refused.
- Pair runs' players are started by workers (`player_slots.py launch`), so they already run inside the worker's fence;
  the daemon starts no pair player (`server/pairRuns.ts` spawns nothing).

## How it works

`server/workerFence.ts`. The daemon's `runSpec` (machine/daemon.ts) adds `fence` to a sandbox agent's spec; `buildOptions`
(server/launch.ts) then gives the SDK `spawnClaudeCodeProcess: fenceSpawner(fence)`, which starts the CLI as
`/usr/bin/sandbox-exec -p <profile> <claude> ...`. sandbox-exec execs claude, so the pid the SDK kills is claude's own. The
fence holds for every process claude starts: Bash, subagents, git, gh, uv, batch Unity, `unity-slot run`. The daemon, the
agent host, its hooks and in-process FF Factory tools stay outside it (they are the text guard, which catches mistakes and is not protection; see the section above). Same user; reads, exec and the
network are unchanged. The profile is passed inline, so no file a worker could edit decides it.

The profile (`seatbeltProfile`): `(allow default)`, `(deny file-write*)`, then allow writes in:

| Where | Why (each measured on m5, 2026-11-23) |
|---|---|
| the worker root | the point |
| `/dev/null`, `/dev/tty*`, `/dev/fd/*`, ... | every shell |
| `getconf DARWIN_USER_TEMP_DIR` / `_CACHE_DIR` | system frameworks (Metal shader cache, CoreServices) write there with no setting |
| `~/.ff-factory/unity-slots`, `~/.unity-mcp` | named exceptions with no setting (docs/worker-root.md 2.7); a worker root's mailbox is `<root>/unity-slots` since w5377, so the first is left for installs without one. w5545: requests are no longer files there; the arbiter reads `<app_dir>/slot-queue`, which no worker writes (docs/unity-lifecycle.md, "Asking the daemon") |
| `/tmp/Unity-Upm-<pid>.sock` | Unity's Package Manager: "listen EPERM /tmp/Unity-Upm-<pid>.sock" |
| `/tmp/ilpp.sock-<hash>` | IL post-processing: "ILPPTrigger: Can't find file /tmp/ilpp.sock-..." |
| `/tmp/Unity-ShaderCompilerIPC-<pid>-<n>.sock`/`.lock`, `/tmp/unitypreflock` | shader compiler: "Failed to listen on local IPC stream (Name in use)", then a fatal abort |
| `/tmp/Unity-LicenseClient-*.sock`, `/tmp/.dotnet` | the licensing client's sockets, .NET mutexes and shared memory (it ignores TMPDIR) |
| `~/Library/Logs/Unity`, `~/Library/Unity/licenses` | the licensing client's logs and entitlement cache |
| `~/Library/Caches/com.unity3d.UnityEditor` | Unity's per-user GI cache, Bee cache and `CurlRequestCache.db`: a fenced player build logged "Failed to create GICache directory at the default location" 81,224 times |

and then takes write back from `<CLAUDE_CONFIG_DIR>/projects` but the process's own conversation (`<id>.jsonl` in any
project folder and its `<id>/` folder; w5563, docs/transcript-seal.md), and from `<root>/daemon`, `<root>/secrets`,
`<root>/claude-medium` (the Medium agents' Claude folder, w5543), `<root>/cache-medium` (their uv cache, w5565),
`<root>/tools-medium` (FF Factory's final-factory-agents checkout the agent tools publish takes forward, w5597) and
`<root>/root.json` (later rules win). The main clone
`<root>/repo` stays writable: each sandbox is a git worktree of it, and git keeps the worktree's index, objects and refs
there. With `repo` read-only (the first version of #1115), a fenced commit in a sandbox failed: "Unable to create
'.../repo/.git/worktrees/s1/index.lock': Operation not permitted" (w5333, measured on a stand-in root; the live test
in `server/workerFence.test.ts` now commits in a worktree). The harness's own text guard keeps a careless agent's tools off it, which a script file gets past. The agent's environment adds `CLAUDE_CODE_TMPDIR=<root>/tmp/claude-code` (Claude Code's task output
and its `/tmp/cc-socks` messaging socket move there) and `DISABLE_AUTOUPDATER=1` (the updater writes `~/.local/share/claude`). uv's folders are not set by the fence: `sandboxUvEnv`
gives every sandbox agent and its editor the workers' ones (w5693, w5745; docs/worker-root.md 2.8).

## Reads: the daemon's folder, secrets and root.json are closed (w5546, every OS)

lothsahn (w5546): "workers can't read the secrets and daemon folders on any OS". The fences that refuse a worker's writes
also refuse its reads of `<root>/secrets` (and the folder that really holds the machine credential when it is elsewhere: a
Dev Drive install keeps it in the host folder, `D:\work\ffw\secrets` for root `V:\ffw` on LothDesktop; `secretsDirs`,
machine/readFence.ts, from `tokenFile`), `<root>/root.json` and the daemon's folder (its own `appDir`, and
`<root>/daemon` where that differs). What workers read or run in the daemon's folder is given back, from one list,
`FENCE_READ_ALLOW` (server/daemonReads.ts): the guard's diagnostic reads (`DAEMON_READ_ALLOW`: logs, the code in `src` and
`app`, sandboxes.json, the clean-up files, ...), the gh shim (`gh-app/bin`) and the Unity MCP status files (`unity-mcp`). Never
given back: `daemon.json`, `hosts` (other sessions' specs and environments), `gh-app/tokens.json` (every app's tokens),
`root.json` and `root-backup.json` (dropped from the guard's list too).

**`<root>/steam` is closed too** (w5639, after w5551 made it unwritable): steamcmd, its cached Steam login (the ConnectCache
in steamcmd's config), the upload `config.json`, the daemon's ffbox clone and `uploads.json`. It is every root child in
`DAEMON_ONLY_CHILDREN` (server/claudeHome.ts), read-denied on each OS from that one list: macOS `READ_DENIED_IN_ROOT`
(server/workerFence.ts), Linux `readLockArgs` (machine/writeLock.ts), Windows `noReadUpTargets` (machine/lowIntegrity.ts),
and the probe's closed paths (`daemonOnlyDirs`, machine/readFence.ts). Nothing is given back inside it. Why this locks out
nobody who needs it: the daemon runs steamcmd, the checks and the uploads itself (machine/steamUpload.ts `run`), unfenced and
at Medium, and a No-Read-Up label refuses only a lower integrity; the person's own processes are Medium or unfenced too; no
worker tool reads it (the `steam_upload` tool asks the daemon, and `urgent_release.py` stopped installing steamcmd in w5640).
`steam-lobby-gate`, which workers write, is another child and stays open. It follows the same mode as the rest: `read-fence-off`
takes its label off (Windows) and leaves it out of new runs' rules (macOS, Linux), from the portal with nobody at the machine.
Tests: server/workerFence.test.ts "w5639", server/writeLock.test.ts (a live Landlock run on Linux CI).

A run's own GitHub App tokens file
(`gh-app/sessions/<session>/tokens.json`, w5547, docs/github-apps.md) is given back to that run only (macOS, Linux), as a folder, so its rewrite by rename stays readable.

| OS | How | Where |
|---|---|---|
| macOS | `(deny file-read-data ...)` on the closed paths, then `(allow file-read-data ...)` on the given-back ones (later rules win). Only contents: stat and realpath of a closed path still work. | `seatbeltProfile` `readRules` (server/workerFence.ts); per run `readAllowed` |
| Linux | Landlock only grants, so ff-landlock.py handles read too (`--no-read`, `--read`): it grants read on everything but the closed paths (every sibling off the chain of each closed path's parents; the parents get READ_DIR only) and the given-back ones. Symbolic links are not followed. Landlock rights are inherited down the tree, so a parent's READ_DIR reaches the closed folder: a worker can still list the names in `<root>/secrets` or `<root>/steam`, never open a file there (w5639, CI on #1237). The probe therefore opens up to three files inside each closed folder on Linux, not the folder (`readFenceProbeTargets`). | `readLockArgs` (machine/writeLock.ts), `read_grants` (machine/ff-landlock.py) |
| Windows | A Medium mandatory label with No-Read-Up, `S:(ML;OICI;NWNR;;;ME)` on folders (`S:(ML;;NWNR;;;ME)` on files), set with `SetNamedSecurityInfoW` (icacls cannot set NR); the given-back paths get an explicit `S:(ML;OICI;NW;;;ME)`, which overrides the inherited one. Set at every daemon start when `workerIntegrity` is `low` (a self-update's new `app` folder inherits NR), skipping a label already in place. Never on the system drive: a target on C:, or a junction into it, is skipped and logged. `<root>/steam` is made (empty) before the root is labelled, at start and at the read-fence switch, so a machine whose steamcmd arrives later is closed from the start (w5731); its secret files (`STEAM_SECRET_FILES`: `config.json`, `uploads.json`, `steamcmd/config/config.vdf`) each get a file NR label of their own, since an explicit Low label left on a file would win over the folder's inherited one. | `noReadUpTargets`, `labelNoReadUp` (machine/lowIntegrity.ts), `lowSetup` (machine/daemon.ts) |

Kept working through the daemon's own writes (lockout review of #1193):

- A file workers read that the daemon rewrites (`cleanup-facts.json`, `person-play.json`) is written in place
  (`writeInPlace`, machine/readFence.ts), never by rename: a renamed-in file is a new inode, which a Landlock grant does not
  cover, and on Windows it takes the daemon folder's No-Read-Up label.
- The given-back folders the daemon makes later (`logs`, `rpc` (the daemon's call address, w5545), `unity-mcp`, `unity-slots`, `gh-app/bin`, `gh-app/sessions`) are
  made before the fences are set (`ensureReadBackDirs`), since Landlock skips a path that is not there.
- The fence never stands between the daemon and its updates: only the claude runs it starts are fenced
  (server/launch.ts `fenceSpawner`, `writeLockSpawner`); the daemon, its self-update check (machine/selfUpdate.ts
  `checkPublished`) and the update job (machine/osJob.ts) run unfenced with the daemon's own environment, and the installer
  clones and fetches anonymously. The gh-app helper is only ever in a run's environment (server/launch.ts, GIT_CONFIG_*).

**Modes, off by default** (lockout review of #1193, lothsahn's rule: "warn-only first, enforce only after measured zero
failures, keep a recovery route that needs no person"). The read fence has its own mode per machine, separate from the
write fence's keys, kept in `read-fence` in the daemon's folder (machine/readFence.ts `readFenceMode`; a missing or
unreadable file is `off`). The portal sets it live, with nobody at the machine and no restart: `machine_daemon` with action
`read-fence-off`, `read-fence-warn` or `read-fence-on` (or `POST /api/machines/<id>/daemon` `{"action":"read-fence-warn"}`).
Runs already going keep the fence they started with; the write fence never changes.

| Mode | Runs started from now on | Windows labels | Probe |
|---|---|---|---|
| `off` (default) | no read rules | any No-Read-Up label a closed path still carries (an earlier `on`, a reverted build) is replaced by plain No-Write-Up at each start and at the switch (`openNoReadUp`); a path without one is not touched | none |
| `warn` | no read rules | as `off` | yes, logged |
| `on` | the read rules, once a probe has passed | No-Read-Up set at each start and at the switch | yes; a probe that finds a path workers need refused, or cannot judge one, leaves runs without read rules until one passes |

**`on` is refused on Linux for now** (lockout re-review B4 of #1193, machine/readFence.ts `readFenceOnRefusal`): the switch
answers with the reason, and a `read-fence` file that says `on` there is read as `warn`. See "Linux, a self-update" below:
until the code folder survives an update, `on` would cost every running worker git push, gh, ff-pr and unity-slot at each
update. macOS and Linux: switching to `off` or `warn` covers runs started afterwards only; Seatbelt and Landlock cannot be
lifted from a running process, so runs already going keep the read rules they started with until they end.

The probe (`probeReadFence`, machine/daemon.ts) runs at daemon start and at each switch, in a child of the daemon's own
under the same fence a run gets (macOS Seatbelt, Linux Landlock with the read rules): node opens each closed path (the
secrets folders, the machine token, root.json, daemon.json, gh-app/tokens.json) and each given-back one (FENCE_READ_ALLOW,
`app/machine/ghApp.ts`) read-only and closes it at once, reading no byte, and the daemon logs one line, `read fence (<mode>,
<os>) probe: a/b closed paths refused, c/d given-back paths open; ...` with what it would wrongly refuse or leave open. On
Windows the labels are what refuses, so `warn` sets none and logs what `on` would close.

Since w5747 (from w5733's review of #1232) the probe also runs the owner-secret rules ("Owner secrets" below) as `on` adds
them for a run that holds a token: the owner paths join the closed targets and the fence (Seatbelt `readDenied` plus
`ownerSecrets`, so the Keychain mach denies and the preference-write deny; Landlock `--no-read`). A line `read fence
(<mode>): owner-secret rules would close ...` says what they close (in `warn`: what `on` would). Then tool legs run under
that same fence (`ownerToolLegs`, machine/ownerSecrets.ts): `gh api user` and `git ls-remote` of a private repository
through the GH_TOKEN credential helper, both with the machine login's token and the empty `<root>/gh-worker` gh folder,
must exit 0; on a Mac `security add-generic-password` must fail at once (a hang means a SecurityAgent dialog; a success is
deleted again outside the fence). Their line is `read fence probe, tools under the owner rules (w5747): ...`. A failed
leg, or legs not run because the daemon read no machine gh token, keeps `on` from enforcing, like a wrongly refused path.
A Keychain leg that hung or got through is held (w5752's review of #1245): the daemon records it with its code version in
`read-fence-keychain-held.json` in its own folder, and later probes skip that leg, so a dialog comes back at most once per
code version rather than at every daemon start. The skipped leg still keeps `on` from enforcing; deleting the file or a
daemon update runs it again.
The per-run wiring is `ownerRunWiring` (machine/ownerSecrets.ts), tested in server/ownerSecrets.test.ts.

Only a daemon whose hello offers
`readFenceSwitch` is sent a mode: a daemon from before w5546 took any action but `restart` as an unload, and a daemon now
refuses an action it does not know.

Limits:

- **Linux and Windows, diagnostic files** (in `on` mode): a given-back file in the daemon's folder that the daemon rewrites
  by rename (`sandboxes.json` and `pause.json` through server/durable.ts, `update/job.json` and `update/result.json` through
  machine/selfUpdate.ts `writeJson`, `cleanup-log.jsonl` when it rotates) is a new file afterwards, which a run started
  before it cannot read until the next run (Linux) or the next daemon start (Windows). Only an agent's own `cat` of them
  for diagnosis reads them; no worker tool does (`leftovers.ts` reads `cleanup-facts.json` and `published.jsonl`, both
  written in place). Their writers are left as they are on purpose: the pool's crash-safe writer and the update job are
  what a rewrite could break. The files a worker's tools need (`rpc/`, `unity-slots`, `unity-mcp`, `cleanup-facts.json`,
  `person-play.json`, `published.jsonl`, its own tokens folder) are folders or written in place.
- **Linux, a self-update** (in `on` mode): the update puts the new code in a new `app` folder (scripts/worker/linkJob.ts),
  which a run that outlives the update was never granted, so until that run ends its gh helper, git credential helper and
  `unity-slot` (all `node <daemon>/app/machine/...`) are refused. New runs are fine. This is why `on` is refused on Linux
  until the code moves to a folder that survives the swap (a given-back `code/{app,app.old,app.new}`, or shims at a fixed
  path). Related: `~/.gitconfig` rewritten by rename after a run started (`git config --global`, `gh auth setup-git`) is
  unreadable to that run, and git treats that as fatal; a per-run `GIT_CONFIG_GLOBAL` in a given-back folder would avoid it. Windows has the same window until the
  restarted daemon's start sets the labels again (about a minute on LothDesktop).

- **Linux**: a file made directly in one of the closed paths' parent folders after the run started (a new file straight in
  `$HOME` or the root, or one rewritten there by rename) is not readable by that run; one made below a granted sibling is.
- **Windows**: every Low worker shares one Low token, so the `gh-app/sessions` folder is readable by all of them: each file
  holds only the apps that run was given, but a worker could read another run's file on the same machine. macOS and Linux
  give each run only its own.
- **The gh shim across builds** (lockout re-review B5 of #1193): the helper skips the shim's folder (`FF_GH_APP_BIN`, else
  the folder beside `FF_GH_APP_FILE`, else `gh-app/bin` beside the helper itself, machine/ghApp.ts `ghShimSkipDir`), never
  takes a file that is one of our shims as the real gh (`isGhAppShim`), and refuses after `GH_SHIM_MAX_DEPTH` nested entries
  (`FF_GH_APP_DEPTH`). A run still gets `FF_GH_APP_FILE`, naming `gh-app/tokens.moved`, which is never written: a helper from
  before w5547 (a rollback by linkJob, a revert of #1193) then skips `gh-app/bin` and reads no token, falling back to
  `GH_TOKEN`, instead of running the shim again without end.
- **Windows, BEAST**: its `daemon` and `secrets` are junctions into `C:\ffw-anchor`, which the fence does not touch, so they
  stay readable there until a person decides otherwise.
- **The machine's own Claude login** (w5559, lothsahn: "fenced workers can't read the machine's own Claude login anywhere,
  and keep LothDesktop's C: off limits"): its `.credentials.json` files (`~/.claude`, the legacy folder, the Medium agents'
  folder; `server/claudeHome.ts` `fencedLoginFiles`) are closed with the secrets, through the daemon's `secretsDirs`, so all
  three fences and the read probe take them. Only the files, never the folder: skills in fenced workers read other files in
  `~/.claude` by fixed path (publish-skills' `final-factory-agents-checkout`, `plugins/cache/...`), and on BEAST a Low
  worker's `~/.claude` is the legacy folder itself. The workers' own Claude folder is left out: runs start on their vault
  token and hold no machine login there. On Windows a login on the system drive is labelled only on the machines in
  `machine/readFence.ts` `LOGIN_LABEL_ON_SYSTEM_DRIVE` (BEAST, whose request allows that one label); elsewhere it is left out
  of the labels and the probe and logged at start. In `on` mode the daemon checks the login files' labels every minute and
  sets a missing one again, since a token refresh by a Medium reader (the usage probe) may write the file anew.
- Same as the write half: the guard (server/daemonReads.ts) still decides what a worker's own tools may read; the fence
  is what holds for every process the worker starts.

## Owner secrets: gh login, ~/.ssh, browsers, the Keychain (w5548, w5553, w5560)

Before this, a fenced Mac worker read everything in the owner's home outside the root: measured on m5 (2026-11-25), a
fenced worker's `env -u GH_TOKEN gh auth status` said "Logged in to github.com account bryding (keyring)".

- **What is closed** (machine/ownerSecrets.ts `ownerSecretPaths`, `ownerReadDenied`): the gh login's folder
  (`GH_CONFIG_DIR` or `~/.config/gh`), `~/.ssh`, every browser profile (Chrome, Edge, Brave, Chromium, Firefox, Opera,
  Arc, Vivaldi, Safari and `~/Library/Cookies`), and the login keychain (`~/Library/Keychains`; Linux
  `~/.local/share/keyrings`). They ride the read fence's own mechanism (macOS `WorkerFence.readDenied`, Linux
  `--no-read`), so they are on only when the read fence is `on` and its probe passed, and `read-fence-off` takes them off live.
- **macOS also** denies mach-lookup of `com.apple.authd` and `com.apple.SecurityServer` and denies
  `user-preference-write` (workerFence.ts `ownerSecretRules`, and `PREF_RULES` added once with w5659's `workerPrefFence`). Why both services, measured on m5 (probe 4, 2026-11-25):
  with `~/Library/Keychains` unreadable there is no default keychain, and `security add-generic-password` then has
  SecurityAgent raise a "keychain not found" dialog on the person's screen and waits for a click (its "Reset To
  Defaults" would replace their login keychain). authd alone made the write fail at once but still logged one dialog line;
  SecurityServer alone still hung; both refused the write in 2 s with no dialog, and git over HTTPS, gh, codesign,
  python, uv, node, curl, the Claude CLI and a Unity batch run (licence updated) all passed. Never ship the Keychains read
  deny without both. The preference-write deny refused `defaults write` cleanly, and Unity ran under it.
- **The gh login reaches only runs with no vault token** (w5548): the daemon reads it with `gh auth token` outside the
  fence and gives it to such a run as `GH_TOKEN` (`machineGh`, re-read every 30 minutes). A run that holds a token gets
  `GH_CONFIG_DIR=<root>/gh-worker`, an empty folder, since gh will not start when its config folder is unreadable
  ("failed to load config ... operation not permitted", measured). Only a run with no token at all (the daemon read none)
  keeps the gh folder open, as before.
- **Git never uses the Keychain for github.com**: launch.ts `githubCredentialEnv` clears the system `osxkeychain` helper
  and sets the app helper (a traced `git credential fill` ran only ghApp.ts's helper), and the Claude CLI gets its token as
  `CLAUDE_CODE_OAUTH_TOKEN`, so neither needs the Keychain.
- **Also closed (w5749, from w5733's review)**: `~/.netrc`, `~/.git-credentials`, git's
  `$XDG_CONFIG_HOME/git/credentials` and `~/.config/git/credentials`; gh's other config folders (`~/.config/gh` when the
  daemon has `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` set elsewhere: gh reads one folder, but a worker can point
  `GH_CONFIG_DIR` at any; open, as the gh folder is, to a run with no GitHub token); on Linux the flatpak browsers' homes
  (`~/.var/app/<id>`), snap Brave, and `~/.config`'s browsers when `XDG_CONFIG_HOME` points elsewhere
  (ownerSecrets.ts `ownerSecretPathsMore`, `ownerReadMore`, part of `ownerReadDenied`). They had a warn stage of their
  own first (#1248); since the enforce PR they are owner rules like the rest, so they act only in `on`, and in `warn`
  the probe's `owner-secret rules would close` line lists them. That line is the per-machine check before `on`: uv and
  curl read `~/.netrc` and git's `store` helper reads `~/.git-credentials`, so a machine whose worker tools need one is
  found in `warn`, not by a failed run.
- **Windows: none of this, and no env or wrapper route closes it** (w5749, measured on LothDesktop 2026-11-25). Every
  owner path is in the profile on the system drive, where the fence writes no label ("Never touch C: on Windows"). There
  `lowEnv` moves gh's `APPDATA` into the root, so a Low worker's gh finds no login, and the login's folder is passed
  (`GH_CONFIG_DIR`) only to a run with no token. That stops an honest worker, not one that sets the variable itself:
  - Windows' integrity rule for files is No-Write-Up only, so a Low process reads a Medium file unless the file carries a
    No-Read-Up label (sourced: Microsoft, "Mandatory Integrity Control"). A worker sandbox's agent here runs at
    `Low Mandatory Level` (`whoami /groups`, measured).
  - gh keeps the token in Windows Credential Manager, not in a file: the daemon's own Low self-test (`lowGhSelfTest`, gh
    at Low with the owner's `GH_CONFIG_DIR`) logged `gh authenticates for Low workers (... Lothsahn (keyring))` at
    2026-11-25 13:43 UTC. So a label or deny ACL on `%APPDATA%\GitHub CLI` alone would hide `hosts.yml` but not the
    token: closing the gh login also needs the token out of Credential Manager (git's Credential Manager entries too).
  - What would close it, each a change on the system drive or the person's own login, so lothsahn's or Ben's decision
    (handed up by w5749): No-Read-Up labels (or a deny ACE for Low) on `~\.ssh`, the gh folder and the browser profile
    folders, with the gh login moved out of Credential Manager; or workers as their own Windows account. Until then a Low
    worker can read them.
- **Known limits**: the person's own unfenced processes (the sandbox's Unity editor) are not fenced. `spctl -a -t exec`
  rejects Unity.app with or without the fence ("Unnotarized Developer ID"), so it is no fence check. Linux: a closed path
  in `$HOME` makes `$HOME` a parent the read lock walks, so a file rewritten there by rename after a run started is
  unreadable to that run (the same limit as above).

## The Secret Service and the agents: owner secrets over a socket (Linux, w5748)

Closing the keyring's files is not enough on Linux. A fenced run that cannot open `~/.local/share/keyrings` or `~/.ssh`
can still ask the owner's running services for what they hold, over UNIX sockets in `$XDG_RUNTIME_DIR`:

- the session bus (`bus`), and on it the Secret Service, `org.freedesktop.secrets` (GNOME keyring). The machine's gh login
  is kept there on a desktop Linux ("(keyring)"), and so are the browsers' Safe Storage keys;
- GNOME keyring's own folder (`keyring/control`, `keyring/pkcs11`);
- the ssh agents (`gcr/ssh`, `openssh_agent`, `$SSH_AUTH_SOCK`), which sign with the owner's keys;
- gpg-agent (`gnupg/S.*`).

**Measured on biscuit** (Linux 7.0.0-38, Landlock ABI 8, 2026-11-25, from inside the daemon's real worker lock):
`busctl --user status org.freedesktop.secrets` answered (w5733), the login keyring collection lists 9 items (an
object-path count; no secret was read), and all 12 of these sockets accepted a connect. `ff-landlock.py --deny-unix`
needs `LANDLOCK_ACCESS_FS_RESOLVE_UNIX`, ABI 9 (Linux 7.1): on ABI 8 it is a no-op that says so on stderr.

**The read-fence probe says it** (`probeOwnerSockets`, machine/daemon.ts; `ownerSocketPaths`, `ownerSocketProbeTargets`
in machine/ownerSecrets.ts; `SOCKET_PROBE_SCRIPT`, `sayOwnerSocketProbe` in machine/readFence.ts). In `warn` and `on`
modes on Linux, a child of the daemon's own, under the same lock and read rules a run gets, connects to each owner socket
and closes it, sending nothing (a test server sees no byte), and the daemon logs one line, as on biscuit:

    read fence (warn, linux) owner sockets: 0/12 refused (Landlock ABI 8); reachable from a fenced run: /run/user/1000/bus, ...

In `on` mode on Linux, read rules take effect only once this probe finds every owner socket refused (`readFenceEnforced`;
a probe that cannot run counts as reachable), and a run in `on` mode gets `ownerSocketDenyArgs` with its other owner
rules, so `read-fence-off` takes them off live. While a socket answers, `on` logs why and runs start without read rules
(a warn, never a lockout).

**The three ways to close it, and what each costs** (measured on biscuit unless marked):

| Option | Closes | Cost |
|---|---|---|
| Deny the sockets to fenced runs | All of them, where the kernel can: only Landlock ABI 9 | On ABI 8 nothing unprivileged can. seccomp cannot tell one socket path from another. A mount namespace to hide them is refused (`unshare -Urm true`: "write failed /proc/self/uid_map: Operation not permitted"; `kernel.apparmor_restrict_unprivileged_userns = 1`). Unsetting `DBUS_SESSION_BUS_ADDRESS` is no fence: the worker sets it back, and `systemd-run --user` reaches `$XDG_RUNTIME_DIR/systemd/private` without it. Where it works, workers lose nothing they need. With the bus pointed at nothing and `SSH_AUTH_SOCK` empty, these all passed: `gh api user` (token and an empty gh folder, as fenced runs get), `git ls-remote` over HTTPS, Node and Python HTTPS, and `claude --version`. The bus deny has shipped in `writeLockArgs` since w5562. |
| Refuse to enforce owner secrets below ABI 9 | Nothing on biscuit. It stops `on` from claiming the gh login is closed while the keyring hands it out | No worker loses anything; Linux below 7.1 keeps no read rules (it already has none: B4 refuses `on` on Linux) |
| Move the daemon's gh login off the keyring (`gh auth login --insecure-storage`, into `~/.config/gh/hosts.yml`, which the fence closes) | The gh token only | Changes the machine's own setup (a person's step). Leaves 8 other keyring items, the ssh and gpg agents and the systemd escape open, so the route to `org.freedesktop.secrets` stays |

**The pick: deny the sockets where the kernel can, and refuse `on` where it cannot.** A run in `on` mode denies the
bus, keyring and agent sockets (`--deny-unix`; the bus and systemd were already denied to every locked run since w5562),
and `on` takes effect on Linux only once this probe finds every owner socket refused. A kernel below ABI 9 never passes, so biscuit stays unenforced until it runs Linux 7.1 or
newer. That is the kernel's limit, not a setting. Lothsahn's call (w5562, 2026-11-25: "Leave it until Ubuntu's normal updates bring
7.1"): no kernel upgrade by hand (not the 7.3 OEM kernel the archive offers, not unprivileged user namespaces), so Linux
stays warn-only until Ubuntu's normal kernel reaches 7.1. Moving the gh login alone would not meet "cannot reach
org.freedesktop.secrets", so it is not handed up.

**The READ_DIR limit** (#1193's documented limit, kept): Landlock rights are inherited down the tree, and every parent on
the chain to a closed path keeps READ_DIR so its other children stay listable. That READ_DIR reaches the closed folder
too. A fenced run can list the file names in `~/.ssh`, `~/.local/share/keyrings`, `<root>/secrets` or `<root>/steam`,
and open none of them (refused). Landlock only grants, so ff-landlock.py cannot take back a right a parent's rule gives.
The names stay visible on Linux; on macOS Seatbelt's `file-read-data` deny also covers listing.

## Trial results (m5, macOS 26.4, 2026-11-23)

Measured with the generated profile unless noted:

- Refused (EPERM, "Operation not permitted"): writes in home, `~/Documents`, `~/Library/Logs`, `/Users/Shared`, `/tmp`,
  mkdir in home, append to `~/.zshrc`, the daemon's folder and its log, the main clone (in the first version only: now writable, above), secrets, root.json, a rename into
  home, a write through a symlink out of the root, a hard link of a home file into the root.
- Works: git commit, `gh api` by GH_TOKEN, `git ls-remote` through the credential helper, uv, npm, `unity-slot`.
- A whole Claude Code turn (`claude -p`, mock API) ran its Bash tool inside: write in the root OK, home and /tmp refused.
- Unity 6000.3.19f1 batchmode compile of the game: 0 `error CS`, exit 0, licence resolved. Two "attempt to write a
  readonly database" lines open the fenced log and not the unfenced one: a system framework's SQLite file outside the root
  (guess: `~/Library/Accessibility/*.sqlite`, which editors hold open), refused without effect.
- Batch player build: see the w5333 PR.

## Known limits

- **Linux is warn-only until its kernel has Landlock ABI 9 (Linux 7.1)** (w5748; lothsahn: "Leave it until Ubuntu's
  normal updates bring 7.1"). Below it a fenced run still reaches the session bus (the Secret Service, where the gh login
  is kept), GNOME keyring and the ssh and gpg agents, and `on` keeps no read rules: biscuit (Ubuntu 26.04, 7.0.0-38, ABI 8)
  measured all 12 owner sockets reachable. A newer kernel alone does not turn `on` on: `readFenceOnRefusal`
  (machine/readFence.ts) still refuses `read-fence-on` on every Linux kernel for the self-update lockout (B4 of #1193).
  Once Ubuntu ships 7.1, the owner-socket probe can pass by itself; `on` then still needs B4 fixed and a person's switch.
  `live w5748 enforce` (server/w5748OwnerSockets.test.ts) is the check to run there first: it skips below ABI 9 and has
  never run.
- **Preferences through cfprefsd** (EditorPrefs, PlayerPrefs, `defaults write`) are written by cfprefsd, outside the
  sandbox, so the file rules never see them: from inside the fence a `defaults write` of a new domain made its plist in
  `~/Library/Preferences` (measured on m5). daemon.json `"workerPrefFence": true` adds `(deny user-preference-write)`
  (`PREF_RULES`, w5659), once the daemon restarts (the fence is decided once per daemon process). Measured on m5, macOS 26.4:
  - cfprefsd lets a write through when the client may write preferences **or** the plist's file. The rule therefore works
    only with the file deny of `~/Library/Preferences`: together, a fenced `defaults write com.<new>` exits 1 ("Could
    not write domain") and makes no plist. The rule alone did not refuse it.
  - Reads still work (`defaults read com.unity3d.UnityEditor5.x` gave the same lines as unfenced).
  - Unity is not hurt: a batch Unity under the profile with the rule compiled, passed `SimulationRateConstantsTest` 31/31
    and the PlayMode `PlayModeTestsWriteNoQuitSavesTest`, while cfprefsd rejected 66 of its EditorPrefs and PlayerPrefs
    writes. A refused EditorPrefs write is silent to Unity, so a worker's batch run no longer changes the user's
    EditorPrefs, such as Burst's on/off (w5270).
  - The daemon's own writes (App Nap, Burst's EditorPref) run outside the fence and are untouched.
  - **No warn-only form exists on macOS.** The sandbox logs nothing for a rule, neither for an allow `(with report)` nor for
    a deny, and `(trace ...)` writes no file (measured). Only cfprefsd logs each refusal: `log show --predicate
    'eventMessage CONTAINS "rejecting write"'`, run from outside the fence. So the switch is off until it is enforced.
  - The Keychain goes through securityd and stays open.
- **The macOS sandbox reports nothing**: on m5 (macOS 26.4), no `Sandbox:` unified-log line and no kernel `deny(1)` line
  were found for any refused write in 3 h of fenced workers being refused (measured, w5659). Evidence of a refusal is the
  tool's own error (EPERM, "Operation not permitted").
- **A licensing client a fenced editor starts stays fenced** after the editor exits, and a later unfenced editor may talk
  to it. It still writes only where the profile allows, which is where it needs to (measured: the licence resolved).
- **Unity's fixed `/tmp` names**: a new Unity version that adds one fails until the profile allows it; the failure is
  loud (the editor aborts or a step fails with EPERM), and the fix is one line here.
- `sandbox-exec` is marked deprecated by Apple but ships in macOS 26.4 and is what Chromium, Bazel and Claude Code's own
  sandbox use.
- A person's own editor and the daemon are never fenced.
- **Sandbox editors** the daemon starts on a Mac run under this profile, warn-only unless daemon.json says
  `"editorFence": true` (w5630; docs/worker-root.md 4.1, "macOS: sandbox editors start under the workers' Seatbelt
  profile"). Their HOME moves to `<root>/home`, so Unity's `~/Library` writes land in the root.

## Signals and launchd jobs (w5562)

lothsahn (w5562): "probe, then block signals and launchctl/systemd-run escapes on Mac and Linux". From the rogue-worker
audit w5451, items 22 and 23.

- **Signals.** Before w5562 a fenced worker could signal any process of its user: on m5, 2026-11-25, `kill -0` from
  inside the fence reached the daemon's agent host and Finder (only launchd, pid 1, answered EPERM). The profile now ends
  with `(deny signal)` and `(allow signal (target self) (target children) (target same-sandbox))` (`SIGNAL_RULES` in
  `server/workerFence.ts`): a worker signals itself and what it started, which inherits its sandbox, and nothing else.
  Signal 0 counts, so a liveness check of an outside process answers EPERM, which our checks read as alive
  (`isAlive` in `machine/unitySlots.ts`, `bench_queue.py`, `player_slots.py`). What a worker needs ended outside its tree
  (its editor, a daemon job) goes through the daemon (`mcp__machine__unity`, `unity-slot`), as before.
- **launchd jobs.** No rule is needed: launchd refuses job submission from a sandboxed caller. Measured on m5 from inside
  the fence (2026-11-25): `launchctl submit -l <label> -- <cmd>` exits 1 ("Operation not permitted"),
  `launchctl bootstrap gui/<uid> <plist>` fails "5: Input/output error", and neither job ever ran. That goes over the
  bootstrap port, not a `mach-lookup` name a profile could deny.
- Still open: `open`/LaunchServices and Apple events (`osascript` telling Terminal to run a script) start programs
  outside the fence; untried.

## Setuid programs: ps, top (w5397)

macOS refuses to exec a setuid program inside the sandbox, whatever the profile says: on m5 (2026-11-24, w5393) a
fenced agent's `ps -x -o pid=` gave "operation not permitted: ps", and `ff-leftovers list` and `end` died on
"spawn EPERM". `/bin/ps` and `top` are setuid root; `pgrep`, `lsof` and `kill` are not and work. KERN_PROCARGS2
(sysctl) works too, but hides the environment of Apple's own binaries (`/bin/zsh`, `/bin/sleep`: 0 entries, measured),
and ff-leftovers finds a process's session by `FF_SESSION_ID` in its environment, so that is not enough.

So the daemon, outside the fence, reads for the worker (`machine/procsBroker.ts`): the worker writes
`<FF_UNITY_SLOTS>/procs/ask-<id>.json` (`procs`, `env`, `inspect` or `census`, with pids and `who`), the daemon answers
`ans-<id>.json` within 250 ms. It answers only those fixed reads and never runs or ends anything for a worker;
ff-leftovers ends its own processes with kill(2). A worker tries its own `ps` first and asks only when the exec is
refused, so an unfenced worker works as before. `stopTree` (unity-slot) falls back to `pgrep -P` when `ps` prints nothing.

Each worker sees only its own processes (w5558, the rogue-worker audit w5451 item 32). The ask names `who`: the
worker's session (`FF_SESSION_ID`) and the asking pid; the daemon refuses it unless that pid runs and the nearest process
on its parent chain that carries a session carries that one (`sessionScope` in `machine/leftovers.ts`). `procs`, `env`
and `inspect` then cover the session's processes (by `FF_SESSION_ID`, or its shells' process groups for an Apple program,
w5401), what they run that carries no other session, and their parents without environment; no other process's
environment is ever answered. The one worker read that needs more is the clean-up's KEEP check (`ff-leftovers folders`,
`check`, `remove`, `remove-slot`: does anyone build in, play from or run in this slot, sandbox or runner folder?):
`census` gives the pid, parent and command line of the processes whose command line names the install folder or an agent
host, with no environment; without a known install folder it answers nothing, and the clean-up keeps. Limit: a worker
that sets out to lie can name another live worker's pid and session (same user; it can read a node process's
environment itself through KERN_PROCARGS2); the check stops the broker handing every worker the whole machine, not a
determined forger. The broker runs only on macOS: elsewhere there is no worker fence, a worker runs its own `ps`
(Linux `/proc`, Windows CIM) as the same user, and the daemon hands it nothing.

zsh writes heredocs under `TMPPREFIX` (default `/tmp/zsh`), refused by the fence ("can't create temp file for here
document"); the fence's environment sets `TMPPREFIX=<root>/tmp/zsh`.
