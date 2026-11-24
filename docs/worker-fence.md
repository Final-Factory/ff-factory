# The worker write fence (macOS, w5333 trial)

lothsahn (w5333): "Regardless of user the workers should only write to the v: on windows. Ideally they'd only be allowed
to do that." On a Mac the worker root is `~/ffw` (docs/worker-root.md), so the fence is: a sandbox agent writes only in
`~/ffw`, and every other write is refused by the kernel.

**Off by default.** `"workerFence": "seatbelt"` in a Mac's daemon.json turns it on for that machine's sandbox agents (the
daemon reads it at start; check it after a redeploy rewrites daemon.json). On another OS, with no `root`, or without
`/usr/bin/sandbox-exec`, the setting logs one line and agents run unfenced.

## How it works

`server/workerFence.ts`. The daemon's `runSpec` (machine/daemon.ts) adds `fence` to a sandbox agent's spec; `buildOptions`
(server/launch.ts) then gives the SDK `spawnClaudeCodeProcess: fenceSpawner(fence)`, which starts the CLI as
`/usr/bin/sandbox-exec -p <profile> <claude> ...`. sandbox-exec execs claude, so the pid the SDK kills is claude's own. The
fence holds for every process claude starts: Bash, subagents, git, gh, uv, batch Unity, `unity-slot run`. The daemon, the
agent host, its hooks and in-process FF Factory tools stay outside it (they are the guard). Same user; reads, exec and the
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

and then takes write back from `<root>/daemon`, `<root>/secrets` and `<root>/root.json` (later rules win). The main clone
`<root>/repo` stays writable: each sandbox is a git worktree of it, and git keeps the worktree's index, objects and refs
there. With `repo` read-only (the first version of #1115), a fenced commit in a sandbox failed: "Unable to create
'.../repo/.git/worktrees/s1/index.lock': Operation not permitted" (w5333, measured on a stand-in root; the live test
in `server/workerFence.test.ts` now commits in a worktree). The harness's own guard still keeps agents' tools off it. The agent's environment adds `CLAUDE_CODE_TMPDIR=<root>/tmp/claude-code` (Claude Code's task output
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
