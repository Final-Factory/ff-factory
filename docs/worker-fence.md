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

**Fixes, by state** (a fix is "merged" only when its PR has merged; everything else is in progress):

- Merged: standing-agent shell guard refuses the w5452 bypass forms (w5504, #1150); standing agents' git ignores repo-config
  programs (w5514, #1152); root-owned releases and an activation that verifies commit, clean tree and path (w5505, #1149);
  a machine's session report sets only run state (w5515, #1155); machine updates install exactly the verified commit
  (w5516, #1161).
- In progress, PR open: label Low only the root folders workers write (w5539, #1166); fenced workers signal only their own
  processes, and the Linux lock refuses the systemd user bus (w5562, #1168); the evidence check runs only a
  `pr_evidence.py` workers cannot have written (w5542, #1171); no process the portal starts can read the vault key
  (w5506, #1154).
- In progress, no PR yet: workers cannot read the secrets and daemon folders on any OS (w5546); the fence fails closed with a
  portal alert (w5555); the gh-config and Keychain read deny (w5548). Until they land, treat every item in the "does not
  cover" column as open.

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
| `~/.ff-factory/unity-slots`, `~/.unity-mcp` | named exceptions with no setting (docs/worker-root.md 2.7); a worker root's mailbox is `<root>/unity-slots` since w5377, so the first is left for installs without one |
| `/tmp/Unity-Upm-<pid>.sock` | Unity's Package Manager: "listen EPERM /tmp/Unity-Upm-<pid>.sock" |
| `/tmp/ilpp.sock-<hash>` | IL post-processing: "ILPPTrigger: Can't find file /tmp/ilpp.sock-..." |
| `/tmp/Unity-ShaderCompilerIPC-<pid>-<n>.sock`/`.lock`, `/tmp/unitypreflock` | shader compiler: "Failed to listen on local IPC stream (Name in use)", then a fatal abort |
| `/tmp/Unity-LicenseClient-*.sock`, `/tmp/.dotnet` | the licensing client's sockets, .NET mutexes and shared memory (it ignores TMPDIR) |
| `~/Library/Logs/Unity`, `~/Library/Unity/licenses` | the licensing client's logs and entitlement cache |
| `~/Library/Caches/com.unity3d.UnityEditor` | Unity's per-user GI cache, Bee cache and `CurlRequestCache.db`: a fenced player build logged "Failed to create GICache directory at the default location" 81,224 times |

and then takes write back from `<CLAUDE_CONFIG_DIR>/projects` but the process's own conversation (`<id>.jsonl` in any
project folder and its `<id>/` folder; w5563, docs/transcript-seal.md), and from `<root>/daemon`, `<root>/secrets` and
`<root>/root.json` (later rules win). The main clone
`<root>/repo` stays writable: each sandbox is a git worktree of it, and git keeps the worktree's index, objects and refs
there. With `repo` read-only (the first version of #1115), a fenced commit in a sandbox failed: "Unable to create
'.../repo/.git/worktrees/s1/index.lock': Operation not permitted" (w5333, measured on a stand-in root; the live test
in `server/workerFence.test.ts` now commits in a worktree). The harness's own text guard keeps a careless agent's tools off it, which a script file gets past. The agent's environment adds `CLAUDE_CODE_TMPDIR=<root>/tmp/claude-code` (Claude Code's task output
and its `/tmp/cc-socks` messaging socket move there) and `DISABLE_AUTOUPDATER=1` (the updater writes `~/.local/share/claude`).

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

## Setuid programs: ps, top (w5397)

macOS refuses to exec a setuid program inside the sandbox, whatever the profile says: on m5 (2026-11-24, w5393) a
fenced agent's `ps -x -o pid=` gave "operation not permitted: ps", and `ff-leftovers list` and `end` died on
"spawn EPERM". `/bin/ps` and `top` are setuid root; `pgrep`, `lsof` and `kill` are not and work. KERN_PROCARGS2
(sysctl) works too, but hides the environment of Apple's own binaries (`/bin/zsh`, `/bin/sleep`: 0 entries, measured),
and ff-leftovers finds a process's session by `FF_SESSION_ID` in its environment, so that is not enough.

So the daemon, outside the fence, reads for the worker (`machine/procsBroker.ts`): the worker writes
`<FF_UNITY_SLOTS>/procs/ask-<id>.json` (`procs`, `env` or `inspect`, with pids), the daemon answers `ans-<id>.json`
within 250 ms. It answers only those three fixed reads and never runs or ends anything for a worker; ff-leftovers ends
its own processes with kill(2). A worker tries its own `ps` first and asks only when the exec is refused, so an unfenced
worker works as before. `stopTree` (unity-slot) falls back to `pgrep -P` when `ps` prints nothing.

zsh writes heredocs under `TMPPREFIX` (default `/tmp/zsh`), refused by the fence ("can't create temp file for here
document"); the fence's environment sets `TMPPREFIX=<root>/tmp/zsh`.
