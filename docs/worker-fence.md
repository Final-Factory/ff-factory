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
| Windows Low integrity | writes outside the root, registry under HKCU\Software, scheduled tasks, shutdown (measured on BEAST); writes to `daemon`, `secrets`, `ffu-runners`, `tools\node` | reads of anything, including `secrets\`; writes to every other sandbox, instance portals, `claude\` and players inside the root; signalling or injecting into other Low workers' processes; the network; code that runs above the fence (the instances updater task, a Medium editor, the daemon's `git status`) |
| macOS Seatbelt | file writes outside the root; other conversations' transcripts in the root's Claude home (w5563, docs/transcript-seal.md) | reads (`~/.ssh`, browsers, `~/.config/gh`, the Keychain through securityd); preferences through cfprefsd; signals to other processes of the user; other sandboxes inside the root; the network |
| Linux Landlock | file writes outside the root | reads; signals; other sandboxes inside the root; the network; the systemd user bus (`systemd-run --user`, guess) |
| Any OS | | a worker is not walled off from other workers' sandboxes inside the root (w5451 items 7 and 8) |

**Resource caps** are not a fence, but they bound what one worker can use: memory, processes and temp disk per worker
(w5554, docs/worker-caps.md, with the ways a hijacked worker can still escape them).

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
`<root>/claude-medium` (the Medium agents' Claude folder, w5543), `<root>/cache-medium` (their uv cache, w5565) and
`<root>/root.json` (later rules win). The main clone
`<root>/repo` stays writable: each sandbox is a git worktree of it, and git keeps the worktree's index, objects and refs
there. With `repo` read-only (the first version of #1115), a fenced commit in a sandbox failed: "Unable to create
'.../repo/.git/worktrees/s1/index.lock': Operation not permitted" (w5333, measured on a stand-in root; the live test
in `server/workerFence.test.ts` now commits in a worktree). The harness's own text guard keeps a careless agent's tools off it, which a script file gets past. The agent's environment adds `CLAUDE_CODE_TMPDIR=<root>/tmp/claude-code` (Claude Code's task output
and its `/tmp/cc-socks` messaging socket move there) and `DISABLE_AUTOUPDATER=1` (the updater writes `~/.local/share/claude`).

## Reads: the daemon's folder, secrets and root.json are closed (w5546, every OS)

lothsahn (w5546): "workers can't read the secrets and daemon folders on any OS". The fences that refuse a worker's writes
also refuse its reads of `<root>/secrets` (and the folder that really holds the machine credential when it is elsewhere: a
Dev Drive install keeps it in the host folder, `D:\work\ffw\secrets` for root `V:\ffw` on LothDesktop; `secretsDirs`,
machine/readFence.ts, from `tokenFile`), `<root>/root.json` and the daemon's folder (its own `appDir`, and
`<root>/daemon` where that differs). What workers read or run in the daemon's folder is given back, from one list,
`FENCE_READ_ALLOW` (server/daemonReads.ts): the guard's diagnostic reads (`DAEMON_READ_ALLOW`: logs, the code in `src` and
`app`, sandboxes.json, the clean-up files, ...), the gh shim (`gh-app/bin`) and the Unity MCP status files (`unity-mcp`). Never
given back: `daemon.json`, `hosts` (other sessions' specs and environments), `gh-app/tokens.json` (every app's tokens),
`root.json` and `root-backup.json` (dropped from the guard's list too). A run's own GitHub App tokens file
(`gh-app/sessions/<session>/tokens.json`, w5547, docs/github-apps.md) is given back to that run only (macOS, Linux), as a folder, so its rewrite by rename stays readable.

| OS | How | Where |
|---|---|---|
| macOS | `(deny file-read-data ...)` on the closed paths, then `(allow file-read-data ...)` on the given-back ones (later rules win). Only contents: stat and realpath of a closed path still work. | `seatbeltProfile` `readRules` (server/workerFence.ts); per run `readAllowed` |
| Linux | Landlock only grants, so ff-landlock.py handles read too (`--no-read`, `--read`): it grants read on everything but the closed paths (every sibling off the chain of each closed path's parents; the parents list names only) and the given-back ones. Symbolic links are not followed. | `readLockArgs` (machine/writeLock.ts), `read_grants` (machine/ff-landlock.py) |
| Windows | A Medium mandatory label with No-Read-Up, `S:(ML;OICI;NWNR;;;ME)` on folders (`S:(ML;;NWNR;;;ME)` on files), set with `SetNamedSecurityInfoW` (icacls cannot set NR); the given-back paths get an explicit `S:(ML;OICI;NW;;;ME)`, which overrides the inherited one. Set at every daemon start when `workerIntegrity` is `low` (a self-update's new `app` folder inherits NR), skipping a label already in place. Never on the system drive: a target on C:, or a junction into it, is skipped and logged. | `noReadUpTargets`, `labelNoReadUp` (machine/lowIntegrity.ts), `lowSetup` (machine/daemon.ts) |

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
Windows the labels are what refuses, so `warn` sets none and logs what `on` would close. Only a daemon whose hello offers
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
- Same as the write half: the guard (server/daemonReads.ts) still decides what a worker's own tools may read; the fence
  is what holds for every process the worker starts.

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

- **Not file writes, so not fenced**: preferences through cfprefsd (EditorPrefs, `defaults write`) and the Keychain go
  through system daemons. `(deny user-preference-write)` would close the first; untried.
- **A licensing client a fenced editor starts stays fenced** after the editor exits, and a later unfenced editor may talk
  to it. It still writes only where the profile allows, which is where it needs to (measured: the licence resolved).
- **Unity's fixed `/tmp` names**: a new Unity version that adds one fails until the profile allows it; the failure is
  loud (the editor aborts or a step fails with EPERM), and the fix is one line here.
- `sandbox-exec` is marked deprecated by Apple but ships in macOS 26.4 and is what Chromium, Bazel and Claude Code's own
  sandbox use.
- A person's own editor and the daemon are never fenced.

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
