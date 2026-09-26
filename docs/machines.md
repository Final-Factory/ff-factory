# Machines: agents on the user's Macs

A machine is a whole computer the portal can run agents on, beside the sandboxes on the host. There
is no partitioning: agents work in the Mac's main game clone, the one the user uses (no worktree
unless a task truly needs one). Machines are Macs (the daemon is a LaunchAgent), with ids such as
`m5` or `mini`.

## Requirements

| | on each Mac |
|---|---|
| Reachable | `ssh <host alias>` from the portal host with an existing key, no password prompt |
| Game clone | a clone of the game repo (the one in config `repo.url`) under the home folder, found by its `origin` URL, or pass its path to `add_machine` |
| Claude Code | installed and logged in for the user (the keychain login works: the daemon runs in the GUI session) |
| node | 22.6 or newer (versions without native TypeScript support run with `--experimental-strip-types`); the newest node on the PATH the user's own zsh sets up, or in common install locations, is used |
| Portal URL | a public URL for the portal, e.g. the Tailscale Funnel URL `https://<host>.<tailnet>.ts.net` (config `publicUrl`, or given to `add_machine`) |
| Sleep | set to never, or agents stop when the Mac sleeps (the daemon holds `caffeinate -i` only while agents run) |

The portal can listen on `127.0.0.1` only. The Macs reach it through its public URL, not a tailnet IP.

## Design: a daemon that connects out

Each Mac runs `machine/daemon.ts` as a **LaunchAgent** (`com.fffactory.daemon`, in the user's GUI
session). It opens a WebSocket to `wss://<portal>/machine` with a per-machine token, and runs Agent
SDK sessions locally with the same `AgentSession` code the portal uses, streaming every transcript
event and session update back. The portal keeps the record (state.json, transcripts) exactly as for
sandbox workers, so the UI, the orchestrator's tools and transcripts do not care where an agent runs.

Why not drive sessions over ssh: an ssh session cannot read the login keychain, so Claude Code on
a Mac often looks logged out there, and an ssh connection dies with every sleep or network change. A
LaunchAgent runs in the logged-in session (keychain, the user's `claude` and plugins), starts at
login, restarts if it dies, and reconnects by itself: every ~2 s for the first two minutes after a drop
(a portal restart takes 20-60 s; a refused attempt, such as the proxy's 502 while the portal is down,
ends at once), then backing off to 30 s; a ping every 20 s, and a dead connection is dropped after 45 s
without a pong. If a daemon still has not come back 2 minutes after the portal started or after it
dropped, and its Mac answers ssh, the portal redeploys it by itself (as `add_machine` does), at most
every 30 minutes and never while its agents are running. So after a restart, give daemons a minute
before redeploying by hand.

- **Auth.** A 256-bit token per machine; the portal keeps only its SHA-256 (state.json) and compares
  in constant time. `/machine` is on the public Funnel URL, so a bad token is logged and throttled.
- **Sessions.** The portal creates the session record and tells the daemon what to launch (a
  serialisable launch spec: cwd, model, brief, tools, guard settings, budget). Transcript sequence
  numbers are assigned by the daemon, starting from the portal's last one, so a session resumes
  across daemon restarts. An agent whose machine is offline shows `stopped`; messaging it fails with
  "machine m5 is offline".
- **Tools.** Workers get the machine's `set_label` (same as a sandbox's) via a `machine` MCP server
  whose calls go back to the portal. Unity is not managed in v1: agents use whatever editor and MCP
  the Mac already has (the Mac's own user settings load).
- **Guard.** The workers' guard runs in the daemon, plus rules for the user's own clone. The user's
  standing permission (2026-09-25): to update the clone an agent may set aside or discard local
  changes (`git stash`, `restore`/`checkout -- <paths>`, `reset` of files or `--hard`, `clean`, a
  forced or dirty-tree branch switch), but only after copying them to a fresh timestamped folder in
  `ff-local-backups/` beside the clone (e.g. `~/nevergames/ff-local-backups/<time>/`: the patches, the
  changed and untracked files, the stash list), and it reports what it moved. The guard refuses those
  commands until a backup folder from the last 2 hours exists, and its refusal gives the backup recipe
  (`backupRecipe` in `server/guard.ts`). Staging or committing everything (`add -A`/`.`, `commit -a`),
  force pushes and pushes to the game repo's master/main stay refused. The daemon's own folder
  (`~/.ff-factory`, which holds the token) is protected.
- **Claude account.** Portal-run agents on a Mac (workers and standing agents) use this host's
  `claudeEnv`, so with `CLAUDE_CODE_OAUTH_TOKEN` set (`set_app_config`, write-only) they run on the same
  Claude account as the agents here, not on the Mac's own login. The portal puts it in the launch spec,
  sent over the authenticated daemon connection with each start; the daemon passes it to that agent's
  Agent SDK process only (it overrides the Mac's keychain login for that process). It is never written
  to disk on the Mac, the daemon log redacts tokens, and transcripts are redacted (server/secrets.ts).
  The user's own interactive Claude Code sessions on the Mac are unaffected: they keep the Mac's login.
  `list_machines` and the machine brief show the source: "host token …abcd" or "Mac login". Config
  `machines.useHostClaudeEnv` (default `true`) turns it off everywhere (`false`) or per machine
  (`{ "m3": false }`). An agent already running keeps its account until its process restarts; after an
  update the daemons are redeployed anyway.
- **Limits.** Machine agents run on the Mac, so they do not count toward this host's
  `limits.maxSessions`; each machine has its own limit (default 3).
- **Awake.** While any agent process is live the daemon holds `caffeinate -i`.
- **Standing agents** can be assigned to a machine: their folder is `~/.ff-factory/agents/<id>` on
  that Mac, runs wait (like a full slot) while the machine is offline, and budgets work unchanged.

## Setup and updates, from this host

`add_machine` (orchestrator tool, and a button in the UI) does everything over ssh with this host's
existing keys: finds node (≥ 22.6) and the FF clone, copies the portal's own code
(`git archive` of `server/ shared/ machine/ package*.json`) to `~/.ff-factory/app`, runs
`npm ci --omit=dev`, captures the user's own zsh PATH (login + interactive, so the LaunchAgent sees what their
terminal sees, e.g. `~/bin/gh`), writes `~/.ff-factory/daemon.json` (portal URL, name, token, repo path,
`claude` path) and the LaunchAgent plist, and (re)loads it with `launchctl bootstrap gui/<uid>`.
Running `add_machine` again for the same id (or Redeploy in the UI) updates the code and issues a fresh
token; it refuses while agents are running there unless forced. The user does nothing on the Macs.

**Versions.** A deploy stamps the daemon with the portal's commit (`machine/VERSION`); its hello reports
it, with the protocol number and the tools it can serve. A daemon from another commit or protocol is
outdated (`MachineManager.outdated`): after an app update that is every Mac. The portal redeploys an
outdated daemon by itself as soon as no agent runs there (checked on its hello and every 30 s, at most
every 10 minutes per machine) and tells the orchestrator. Meanwhile a new agent there is refused with
"<id>'s daemon is outdated (...); redeploying it now. Try again in a few minutes." Agents already
running carry on. After an app update, agents on a Mac are resumed only once its daemon is connected and
current (`whenCurrent`, up to 12 minutes); the orchestrator gets a `[machines]` line saying which ones
resumed. The daemon also leaves out any MCP tool its own code does not know, so a newer portal cannot
crash an older daemon's launch.

## Not in v1

Unity lifecycle on the Macs; machines other than Macs.
