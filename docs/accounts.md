# Claude accounts: which agent runs on which

Every agent the portal starts runs on one of three kinds of Claude credential:

- **The host token**: config `claudeEnv.CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), shown as
  "host token …abcd".
- **A computer's stored login**: the claude.ai login made with `claude` → `/login` on that computer. On
  Windows and Linux it is `~/.claude/.credentials.json` (or under `CLAUDE_CONFIG_DIR`); on macOS it is in the
  Keychain. The usage meters show it as "<host> login" or "<machine> login".
- **A person's own token**: config `userClaudeEnv.<user>` ([identity.md](identity.md)). This one always
  wins for work that person asked for, wherever it runs.

## The switches

| Agents | Config | Values | Default |
|---|---|---|---|
| The orchestrator (and the ops worker working for a person) | `claudeAccounts.orchestrator` | `"token"`, `"login"` (this host's), `"tokenfile"` or `"vault"` (each person's own pool, an owner's setting; w738) | `"token"` |
| The dispatcher (w464) | `claudeAccounts.dispatcher` | same; once set it also overrides the system payer's own token in `userClaudeEnv` | unset: the system payer's own token if any, else `claudeAccounts.orchestrator`'s |
| Workers and standing agents on a machine (a Mac, a PC, BEAST, this host's own daemon) | `machines.useHostClaudeEnv` | `true` (host token) or `false` (the Mac's login); global, or per machine | `true` |

The portal runs only the orchestrators and the dispatcher (w510, 2026-10-06), so those are the only agents whose
account it picks itself; every worker and standing agent is on a machine. Until w510 `claudeAccounts.workers` also set
the account of the portal's own sandbox workers, and `claudeAccounts.standing` that of the standing agents it ran; until
w755 `workers` still set that of the workers of the portal's own host as a machine (`add_machine local`, a Windows
portal's own daemon). Both keys are retired: a config that sets one loads (whatever its value), names it once at startup and in
`system_status`, and ignores it (`RETIRED_CONFIG_KEYS`, `server/config.ts`); `set_app_config` no longer takes either. A worker or
standing agent on any machine, the portal's own host's included, follows `machines.useHostClaudeEnv` (the row above): the
entry naming the machine, else the global value or `"*"`, else the host token. A Windows portal that had
`claudeAccounts.workers: "login"` and no entry for its own host's machine now sends that machine's agents the host token;
set `machines.useHostClaudeEnv` to `false` for it to keep the host's stored login (`fff-migrate` writes that entry for BEAST).

### The token file (w464)

`claudeAccounts.orchestrator` and `.dispatcher` also take `"tokenfile"`: those roles run on the
long-lived OAuth token (`sk-ant-oat01-…`, from `claude setup-token`) in the file config `claudeTokenFile` names,
e.g. `/srv/fff/secrets/claude-oauth-token` (docs/portal-on-ffbox-host.md, change 18). Workers never do: a config
setting any other role to it is refused at load, and `set_app_config` refuses it.

- **Read at each session start** (`readTokenFile`, `server/secrets.ts`) and given to that process alone as
  `CLAUDE_CODE_OAUTH_TOKEN`, with every other Claude credential removed first (the server's own, `claudeEnv`'s token,
  an API key). A new token in the file applies to the next session, with no restart.
- **It wins over a person's own token**: a person's orchestrator with a token in `userClaudeEnv` still runs on the
  file when its role is set to it.
- **Never stored or sent anywhere else**: not in `claudeEnv` (so never in a machine's launch spec), not in
  `config.json` (which holds the path), never in an answer or an error (only its last four characters, "token file
  …abcd"). A file that cannot be read, or holds anything but one OAuth token, stops the session start with the reason
  and without the content. Transcripts redact `sk-ant-oat01-` tokens as they always did.
- **The meters** poll it like the other tokens and show it as its own account, "<host>'s token file (the roles on
  it)"; `system_status` names it per role ("token file …abcd", or "UNREADABLE" when the file cannot be read).
- `set_app_config claudeTokenFile "<absolute path>"` checks the file reads as a token; it cannot be cleared while a
  role is set to `"tokenfile"`.

`machines.useHostClaudeEnv` takes `true`/`false` or an object with one entry per machine id, plus `"*"` for
the machines it does not name: `{ "m3": false, "m5": false }`, or `{ "*": false, "m5": true }`.

`claudeAccounts.orchestrator`, `.dispatcher` and `machines.useHostClaudeEnv` are in `set_app_config`'s
allowlist, so the orchestrator can change them when the user asks:

```
set_app_config claudeAccounts.orchestrator "login"
set_app_config machines.useHostClaudeEnv false  machine: "m3"
set_app_config machines.useHostClaudeEnv false  machine: "m5"
```

Without `machine`, `machines.useHostClaudeEnv` sets every machine not named, and keeps the per-machine
entries. `null` removes a setting (back to the default). The server refuses a malformed value when it
loads `config.json` (`checkAccountConfig`, `server/config.ts`).

Setting a role to `"login"` is refused when this host has no login that can run an agent: none stored, or
the access token and the refresh token have both expired (`hostLoginProblem`, `server/secrets.ts`). A login
without the `user:profile` scope is accepted: agents need only `user:inference`, and only the usage meters
need `user:profile`. On macOS a missing file proves nothing, because the login is in the Keychain.

### The token vault (w512) and the pools (w738, w739)

`claudeAccounts.orchestrator` also takes `"vault"` (an owner's switch in `set_app_config`): a person's orchestrator
starts with `CLAUDE_CODE_OAUTH_TOKEN` set to a token of **that person's pool** (their Claude entries in the vault,
`people/<id>/claude-token` and `claude-tokens/<name>` on the FFBox host), read at each session start so a new token
applies to the next session with no restart, and every other Claude credential removed first, as for the token file
(`poolRunEnv`, `server/secrets.ts`). Which of their tokens, and what happens when they are over their caps or used up:
[vault.md](vault.md) section 4. The orchestration worker works the same way, on the pool of the person whose orchestrator
gave it the job, and starts a fresh conversation and process for every new job and every change of caller
([ops-worker.md](ops-worker.md)). **The dispatcher never takes `"vault"`:** it keeps the shared token file (a dispatcher
that inherits `"vault"` from the orchestrator's setting is on the token file, else the host token), and that
credential and the host token keep a reserve for their own roles. A person with no vault token yet falls back to the
token file, as before. `system_status` names the account per role ("each person's own vault pool (token file …dAAA for a
person with no vault token)"), each person's pool with each token's state, and the reserves. The pool limits are config
`vault.pool.*`, one set for everyone, which any person's orchestrator may change: `sessionHoldPercent` 80,
`onePerWeeklyPercent` 95, `retireWeeklyPercent` 99, `reservePerDayPercent` 5, `reserveSessionPercent` 20.

The meters: a session on a pool token shows on that token's account (a live session by the account its process started
on; a stopped orchestrator by the last token it was handed).

#### Machine runs

Machine runs (workers and standing agents on a machine) can take their Claude token from the portal's token vault
instead: config `machines.claudeFromVault` (`true`, `false`, or per machine with `"*"`; default `false`; owner-only in
`set_app_config`, with `machine: "<id>"` for one machine alone) names the machines. Each run then gets one vault token from its person's pool (docs/vault.md section 4), as `CLAUDE_CODE_OAUTH_TOKEN` alone (`LaunchSpec.login` drops the daemon's own credentials). A
person's own token in `userClaudeEnv` still wins for their work. With no eligible vault token the run falls back to
what this page describes. The vault, its other secrets and the cut-over: [vault.md](vault.md).

## What "login" does at launch

A process set to the login starts with **no credential at all in its environment**: the server's own
environment and config `claudeEnv` are merged, then every variable in `AUTH_ENV` (`server/usage.ts`:
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and the rest) is dropped. Claude Code then falls back to the
stored login. This is the same environment the usage tracker uses to poll the host login
(`UsageTracker.refresh`), so the account the meters show as "<host> login" is the one those agents run on.
The other `claudeEnv` variables, such as `CLAUDE_CONFIG_DIR`, stay.

- The orchestrators and the dispatcher: `hostProcessEnv(cfg, role)` (`server/secrets.ts`), used by
  `Agents.orchestratorEnv` (`server/agents.ts`); `buildOptions` (`server/launch.ts`) drops the credentials of the
  environment it starts from.
- Workers and standing agents on a machine (a Mac, a Windows PC, this host's own daemon): the portal sends the host
  token in the launch spec only when the machine takes it (`hostClaudeEnvFor`, `usesHostClaudeEnv`, from
  `machines.useHostClaudeEnv`), and sets `LaunchSpec.login` when it does not
  (`machineUsesLogin`; `server/agents.ts`, and `place` in `server/standing.ts`), so a token left in the daemon's own
  environment cannot stand in for the machine's login either.
- A person's own token is laid over all of these (`claudeEnvFor`, `server/identity.ts`).

## claude.ai connectors (w516)

On a claude.ai login (or a token of a claude.ai account), Claude Code loads that account's **claude.ai connectors** by
itself: Gmail, Google Drive, Google Calendar, Claude Docs and any other connected on claude.ai, as `mcp__claude_ai_*`
tools. An orchestrator's built-in tools are only Read, Glob, Grep, Write and Edit (no tool search), and, as measured below, every connector tool goes into every turn.
Measured on 2026-10-06 (`orchestratorOptions` on a test config, one fresh session per role started with a one-word
prompt on BEAST's login, input tokens of its first request after the connectors connected):

| | with the connectors | without | tools |
|---|---|---|---|
| a person's orchestrator | 65,496 | 24,199 | 86 → 28 |
| the dispatcher | 80,841 | 39,544 | 114 → 56 |

The 58 connector tools (Gmail 30, Google Drive 11, Google Calendar 9, Claude Docs 8) and Claude Docs' instructions were
41,297 tokens. Orchestration never uses them, so they are **off for people's orchestrators and the dispatcher by
default**, and on for workers and standing agents (Ben's creator outreach, w106 and w121, used Gmail). Config
`claudeAiConnectors` sets it per role, with the roles of `claudeAccounts`:

```json
"claudeAiConnectors": { "orchestrator": false, "dispatcher": false, "workers": true, "standing": true }
```

Off is Claude Code's own `disableClaudeAiConnectors` setting for an orchestrator (passed with its other settings in
`orchestratorOptions`), and `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the process environment for a worker or a standing
agent (which reaches a machine's daemon with the launch spec). It does not touch what is connected on claude.ai. It is
in config.json only, not `set_app_config`: it changes what tools an agent has. A malformed value stops the server at
start (`checkConnectorConfig`, `server/config.ts`).

## When a change takes effect

The environment is fixed when an agent's process starts. A change applies to agents started after it;
running ones keep their account until their process restarts. For the orchestrator, that means restarting
the app.

## Attribution: meters, system_status, agent details

Each session maps to an account source key (`sessionSource`, `server/usage.ts`):

1. A running process: the account it **started** on. `AgentSession` records it as `SessionInfo.account` when
   the process starts (`accountKeyOf` of its final environment: `token:<hash prefix>`, or `host:login` with
   no token). A Mac daemon runs the same code and reports it, and the portal reads a Mac's `host:login` as
   that Mac's login (`login:<id>`, `server/machines.ts`). So an orchestrator set to `"login"` shows on the
   token until it restarts, because that is what it runs on. Daemons older than this field leave it unset,
   and their sessions fall through to 2.
2. Otherwise, the account the next process will get from the current config: a person's own token for
   their work; on a Mac the host token or that Mac's login; on this host `host:login` when the session's
   role is set to `"login"`, else the host token.

The usage meters (`buildAccounts`) list which host roles share the token and which the login when they are
split, for example "the agents' token on BEAST (the dispatcher)" and "BEAST login (the
orchestrator)". `system_status` starts its account section with one line naming every role's account, the
account of each machine's agents, and the people with their own token. It adds a warning when a role set
to the login cannot use it.

The usage tracker polls the host token and this host's login whatever the switches say, and each Mac's
daemon polls its own login.

**Only accounts in use are listed (w748).** The usage meters and `system_status`'s "Claude accounts in use" list an account
only when something is set to use it, or an agent is running on it now:
- a **machine's own login** is left out while its machine takes vault tokens (`machines.claudeFromVault`) or the host token
  (`machines.useHostClaudeEnv`), and returns when that machine does neither;
- **this host's stored login** is left out while no role (`claudeAccounts`) is set to `"login"` and a host token exists;
- **the host token** is left out while no role and no machine uses it;
- **vault tokens** are left out while no machine is on the vault and no role is set to `"vault"`.
Since w755 `system_status` names no "workers here" and shows no "<host> login (workers)" row or warning: the only roles are the
orchestrator and the dispatcher (the dispatcher only when it has an account of its own).
**Every vault token is its own row, named by its vault entry (w777).** When the host token, the token file or a person's
`userClaudeEnv` token is the same token as a vault entry, that use goes on the vault row's subtext line, the way a Mac's "m3 login"
is noted ("fff-portal's token file (the orchestrator)", "the agents' token on fff-portal, m5", "agents working for Ben"), with no
row of its own and one usage. A host or token-file token in no vault entry keeps its own row. `system_status` carries the same
row: "- vault-ben-2 …dAAA [fff-portal's token file (the orchestrator); agents on it: …]".
A person's own token and the token file are always listed. A vault token is named by itself ("vault-ben-1 …abcd"), without a
description; the line under a machine login still says where it is used ("m3 login").

## How often

Every account is polled once when the portal starts (a daemon: when it connects, unless it reported in the last half
interval), then every config `usagePollMinutes` (default 15, 5 to 240; `set_app_config usagePollMinutes`). The usage
endpoint rate-limits, so the numbers are allowed to be that old: each account's meters say "as of" when.

- The portal (`UsageTracker`, `server/usage.ts`) counts the interval from its last poll, whatever started it. A
  changed interval applies at once, here and on the daemons (`usage_config`, sent at connect and when it changes).
- Rate-limit events no longer poll (they did, up to once a minute). A new token set with `set_app_config` is polled
  within seconds.
- `system_status` uses the numbers as they are when they are under one interval old, and starts a poll when they are
  older (the last poll failed, or its timer was held up).
- **Refresh usage** under the meters (`POST /api/usage/refresh`) polls every account now, and asks each connected
  daemon for its login (`usage_now`), unless a poll is running or started seconds ago. The next scheduled poll then
  counts from it.
- A request that never answers cannot hold the polls up: each gives up after 75 s, and a poll still marked running
  after 5 minutes no longer blocks the next one.
