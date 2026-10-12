# Claude accounts: which agent runs on which

**Every Claude process the portal starts runs on a token from the vault, and on nothing else (w1078).** There is no host
token, token file, stored login, machine login or per-person token in config. lothsahn, w1078: "Delete claudeTokenFile and its
associated config. Also delete claudeEnv, get rid of the fallback mode, everything runs off the vault". Before w1078 an agent
ran on one of three credentials (the host token in config `claudeEnv`, a computer's stored `/login`, a person's own
`userClaudeEnv` token) chosen by `claudeAccounts`, `machines.useHostClaudeEnv` and `machines.claudeFromVault`; all of that is
removed. The vault, its pools and their limits: [vault.md](vault.md) section 4.

## Who runs on which token

| Process | Token | Code |
|---|---|---|
| A person's own orchestrator | a token of that person's pool, picked at each session start | `Agents.orchestratorEnv` (`server/agents.ts`), `poolRunEnv` (`server/secrets.ts`) |
| The orchestration worker ([ops-worker.md](ops-worker.md)) | the pool of the person whose orchestrator gave it the job; a fresh process for every new job and every change of caller | `poolRunEnv` with role `ops` |
| The dispatcher | the vault token `claudeAccounts.dispatcher` pins (`"vault:<entry name>"`, w996), else the system payer's pool | `pinnedDispatcherEnv`, else `poolRunEnv` |
| Workers and standing agents, on every machine (a Mac, a PC, BEAST, this host's own daemon) | the pool of the person their work is for | `machineRunEnv` |

Whose pool a machine run uses is [vault.md](vault.md) section 10: the person who last acted on the request; for work nobody
asked for (intake, FFBox, nightly), config `vault.unattributed`'s person; else the requester; else the system payer. The pick
within a pool, the caps, and what a held or used-up pool does: [vault.md](vault.md) section 4.

The process starts with that token as `CLAUDE_CODE_OAUTH_TOKEN` and no other Claude credential: `hostBaseEnv` drops the server's
own (`ANTHROPIC_API_KEY` and the rest of `AUTH_ENV`, `server/usage.ts`), and for a machine's run the launch spec sets
`LaunchSpec.login` so the daemon drops its own too (an API key there would outrank the token). A new token in the vault applies
to the next session start, with no restart.

**No usable token.** A pool that is held or used up waits: `PoolHeldError` with the next reset, as before. With no token at all,
or none that the key opens, the session does not start and says why: "<person> has no Claude token in the vault, so <the run>
cannot start: add one with `sudo fffctl vault add-claude <person>` (docs/vault.md, section 4). It never runs on another
credential (w1078)" (`noTokenWhy`, `server/secrets.ts`). The reason is the start error and a warning in `system_status`'s vault
section. A dispatcher pinned to a token the vault cannot give does not start either, and says so. Nothing falls back.

## The settings

Only one account setting is left: `claudeAccounts.dispatcher` (`"vault:<vault entry name>"`, the names `fffctl vault list` shows;
or `"vault"`, which `set_app_config` stores as no key: the system payer's pool). It is an owner-only key in `set_app_config`
(`OWNER_ONLY_KEYS`, `server/appConfig.ts`) and a pin is refused unless the vault holds an enabled Claude entry of that name that its
key opens. It applies at the dispatcher's next process start. `claudeAccounts.orchestrator` is `"vault"` and nothing else; the
portal's start writes it out as `"vault"` (`stripConfig`, `server/configMigration.ts`), so a rollback to an older release also
runs the orchestrators on their pools, and keeps only a pin for the dispatcher (older releases refused a dispatcher `"vault"`). The
rule is checked when `config.json` loads (`checkAccountConfig`, `server/config.ts`).

**Retired (w1078), ignored if present and taken out of config.json at the portal's start** (`RETIRED_CONFIG_KEYS`,
`server/config.ts`): `claudeEnv`, `userClaudeEnv`, `claudeTokenFile`, `machines.useHostClaudeEnv`, `machines.claudeFromVault`;
and the `claudeAccounts` values `"token"`, `"login"` and `"tokenfile"` (`RETIRED_ACCOUNTS`). `set_app_config` no longer takes
`claudeEnv.*`, `userClaudeEnv.*`, `claudeAccounts.orchestrator`, `claudeTokenFile`, `machines.useHostClaudeEnv` or
`machines.claudeFromVault`. Earlier retirements: `claudeAccounts.workers` and `.standing` (w510, w755: the portal runs no
worker or standing agent of its own).

## What w1078 did to config.json

**Two decisions.** lothsahn asked first: "There are two secrets in that config file: "claudeTokenFile" and
"CLAUDE_CODE_OAUTH_TOKEN". Can we move these two to a separate secrets file and let you read and write the rest?", then
corrected himself: "Sorry...  not claudeTokenFile, but providers.ffbox.tokenSha256". Then he decided to remove the Claude
credentials from config altogether (the quote above), and: "Then please migrate providers.ffbox { enabled, tokenSha256 } to a
file in the secrets folder and have the config reference the filename." The result: config.json holds no secret.

**FFBox's connector hash.** Config `providers.ffbox.tokenSha256File` names a file in the secrets folder, in the VM
`/srv/fff/secrets/ffbox-connector-token.sha256` (`0600 fff`), holding the SHA-256 of FFBox's connector token. config.json never
holds the hash. `set_app_config providers.ffbox.token` and `node server/providerToken.ts` write that file (`writeFfboxTokenHash`,
`server/configMigration.ts`); the connector's check reads it at each connection (`ffboxTokenHash`), so a new token applies at
the next connection with no restart. [ffbox-connector-contract.md](ffbox-connector-contract.md), "Auth".

**The one-time change at the portal's start** (`migrateConfig`, `server/configMigration.ts`, called from `server/index.ts`
before `loadConfig`; not in a dry run, whose config is another portal's). It is idempotent: a second run changes nothing.
- Takes the retired keys out of config.json and puts the hash into its file, with `providers.ffbox.tokenSha256File` naming it.
- Keeps config.json as it was in the secrets folder as `config.json.before-w1078-<time>` (`0600`), before anything changes.
- Rewrites every saved version beside config.json (`.prev`, `.1` to `.3`, `.tmp`, `.damaged-…`) without them, or moves it into
  the secrets folder (`<name>.before-w1078`) when it cannot be read and may hold a secret.
- Logs what moved: key names, and a token by its last four characters at most. A value that still looks like a credential
  (`redactSecrets`' patterns, or a URL with a password) is not moved; it is warned about ("config: WARNING config.json <key>
  looks like a credential (not shown)") and keeps config.json closed to agents until a person moves it.

The secrets folder is `FFSB_SECRETS_DIR` if set; else `<app>/secrets` when config.json is in the app folder; else in the VM
`/srv/fff/secrets` (beside a folder named `config`); else a `secrets` folder inside config.json's own folder, so a portal on a
config in a temp folder never shares one (`secretsDirOf`). The read guard closes each of them.

**The retired token file.** `/srv/fff/secrets/claude-oauth-token` (what `fffctl claude-token` wrote for the `"tokenfile"`
account) is deleted by the portal, with no copy, once this release's deploy has verified (`data/update.verified*.json` names
its commit) and the dispatcher runs on a vault token (`retireOldTokenFile`, checked every minute until it is gone).
lothsahn: "and does anything use /srv/fff/secrets/claude-oauth-token or can we delete that file too? if so, let's delete it."
What referenced it before, all removed: config `claudeTokenFile`, the `"tokenfile"` accounts, `fffctl claude-token` (wrote it),
`fffctl configure --claude-tokenfile`, `fffctl state`'s `claudeToken`, the host installer's claude-token answer and hand-over
(`deploy/vm/host/answers.sh`, `guest.sh`), and the token meters. `fffctl claude-login` is gone too. A fresh VM gets its Claude
tokens through the vault: `sudo fffctl vault add-claude <person>`, or the host's `people/<id>/claude-tokens` files synced by
`fff-vm vault-sync` ([vault.md](vault.md) section 11).

**Rolling back** the portal to a release from before w1078: `fff-update` puts FFBox's hash back into config.json (that release
has no `server/configMigration.ts`); a newer release's start moves it out again. [portal-on-ffbox-host.md](portal-on-ffbox-host.md)
7.5a.

## Who may read and change config.json

The orchestrators' secret guard used to refuse every read of config.json. Now that it holds no secret, it allows exactly these:
config.json and its saved versions (`.prev`, `.1` to `.3`) **while they hold no secret** (`readableConfigFiles`,
`inlineSecrets`), to **Lothsahn's and Ben's own orchestrators and the dispatcher** for Read and Grep (`mayReadConfig`,
`server/agents.ts`). The list is computed at each session start. In the VM the rest of `/srv/fff/config` stays closed, and other
people's orchestrators and standing agents are still refused. The secrets folder (the hash, the backup) is closed to every agent.

Nobody Writes or Edits config.json. A change goes through `set_app_config`: it checks the value, applies it to the running
portal, and keeps the old file as `config.json.prev`. A malformed hand edit would stop the portal at its next start; Edit would
skip the validation and the live apply, could change keys `set_app_config` deliberately leaves out (paths, permissions, models,
`protectedPaths`) and could put a secret back. `set_app_config` is now also in Lothsahn's and Ben's own orchestrators, **only in
a turn their person started with a message of their own** (`personalSettingProblem`, `server/agents.ts`), never in a harness
turn (a check-in, a timer, a relayed report). The dispatcher keeps its existing guard: a person's own turn in its chat, or a
work_id they filed (`USER_ASKED_TOOLS`, `server/belts.ts`). More: [orchestrators.md](orchestrators.md).

The ops worker reads it with `sudo fffctl config` (every setting; a value that looks like a secret shows as "[not shown]", the
retired keys left out) and `sudo fffctl config --check` ([ops-worker.md](ops-worker.md)). Changing a setting is not its job.

**The schema, audited for secrets (w1078).**

| Key | Decision |
|---|---|
| `claudeEnv` | removed (lothsahn) |
| `userClaudeEnv` | removed: a per-person non-vault token; people's tokens are their vault pools |
| `claudeTokenFile` | removed: a path, but its only use was the retired token-file account |
| `providers.ffbox.tokenSha256` | moved to a file in the secrets folder (lothsahn); config keeps `tokenSha256File` |
| `unity.mcpServer.env` | stays: no credential in it today; any value that looks like one makes the config unreadable to agents and is warned at start |
| `vault.keyFile`, `anthropicApiKeyFile` | stay: paths; the files are closed by the guard |
| `vault.unattributed`, `vault.githubRepos`, `vault.pool` | stay: not secret |
| `max.eventsFile`, `max.ffboxConfigDir`, `max.discordApi` | stay: paths and a URL; Max's Discord token is in the ffbox config's `secrets.env`, closed |
| `outsideWatch` | stays: its ntfy topic is in `data/outside-watch.json`, closed |
| `intake.discord.trusted` | stays: Discord user ids are public |
| `repo.url`, `publicGitIdentity.repos`, `publicUrl` | stay: a URL with a password in it would be warned and keep config closed |
| `systemPayer`, `ownerName`, everything else | stays |

## After the w1078 deploy: the check

For the ops worker, after the deploy that carries w1078. Never print a token: last four characters only.

1. `sudo fffctl config --check` exits 0: config.json and its saved versions hold no secret; the hash file is `0600 fff` and the
   check prints its last four characters; the retired token file is gone, which may take a minute or two after the deploy
   verifies.
2. `system_status` shows each role's account as a vault token by its last four characters (the dispatcher's pinned one, each
   person's orchestrator on their pool), and no "host token", "token file" or "login".
3. FFBox shows online in `system_status`: its connector reconnected with the hash from the file.
4. The journal (`sudo fffctl logs`) shows the start's line "config: changed config.json (w1078 …): …" and, later, "config:
   deleted the retired Claude token file …".

## claude.ai connectors (w516)

On a token of a claude.ai account (or, before w1078, a stored login), Claude Code loads that account's **claude.ai connectors** by
itself: Gmail, Google Drive, Google Calendar, Claude Docs and any other connected on claude.ai, as `mcp__claude_ai_*`
tools. An orchestrator's built-in tools are only Read, Glob, Grep, Write and Edit (no tool search), and, as measured below, every connector tool goes into every turn.
Measured on 2026-10-06 (`orchestratorOptions` on a test config, one fresh session per role started with a one-word
prompt on BEAST's stored login, which w1078 retired; the token path loads the same connectors; input tokens of its first request after the connectors connected):

| | with the connectors | without | tools |
|---|---|---|---|
| a person's orchestrator | 65,496 | 24,199 | 86 → 28 |
| the dispatcher | 80,841 | 39,544 | 114 → 56 |

The 58 connector tools (Gmail 30, Google Drive 11, Google Calendar 9, Claude Docs 8) and Claude Docs' instructions were
41,297 tokens. Orchestration never uses them, so they are **off for people's orchestrators and the dispatcher by
default**, and on for workers and standing agents (Ben's creator outreach, w106 and w121, used Gmail). Config
`claudeAiConnectors` sets it per role (the orchestrator and the dispatcher, plus `workers` and `standing`):

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

Each session maps to one account source key (`sessionSource`, `server/usage.ts`): the account its process **started** on.
`AgentSession` records it as `SessionInfo.account` when the process starts (`accountKeyOf` of its final environment:
`token:<hash prefix>`). A daemon runs the same code and reports it. A session whose process never started has none. The meters
attribute a stopped session of this host's by the token it ran on last (the dispatcher's pinned token, else the pool token it
was handed last, `Vault.lastPickOf`), and a live one by the account it started on.

**Only vault tokens are listed (w1078).** The usage tracker polls the vault's Claude tokens (`usage.personTokens = () =>
vault.claudeTokens()`, `server/index.ts`) and nothing else: no host token, no host login, no machine login. The meters and
`system_status`'s "Claude accounts in use" list each vault token as its own row, named by its vault entry ("vault-ben-2 …dAAA"),
with the Claude account email a person recorded on the entry first ([vault.md](vault.md) 12.0), and under it where it is used:
the dispatcher, agents working for a person. A machine's own login is left out (`unused`, `buildAccounts`, `server/usage.ts`:
every machine's runs are on vault tokens) unless a session is running on it. Each pool token carries its `pool:<state>` label (`priority` on the
one a new job gets, [vault.md](vault.md) section 4).

`system_status` starts its account section with one line (`accountSetupLines`, `server/secrets.ts`): "Claude account per agent
(every one a vault token, docs/vault.md; w1078: no host token, token file or login)", naming the orchestrators and the
orchestration worker on their person's own pool, the dispatcher on its pinned token by its last four characters or on the system
payer's pool (or, for a pin the vault cannot give, that it does not start), and workers and standing agents on every machine on
the pool of the person their work is for. It adds a warning when a person has no usable token or the vault cannot open one, and a
reserve line for the dispatcher's pinned token ([vault.md](vault.md) section 4).

## How often

Every vault token is polled once when the portal starts (a daemon: when it connects, unless it reported in the last half
interval), then every config `usagePollMinutes` (default 15, 5 to 240; `set_app_config usagePollMinutes`). The usage
endpoint rate-limits, so the numbers are allowed to be that old: each account's meters say "as of" when.

- The portal (`UsageTracker`, `server/usage.ts`) counts the interval from its last poll, whatever started it. A
  changed interval applies at once, here and on the daemons (`usage_config`, sent at connect and when it changes).
- Rate-limit events no longer poll (they did, up to once a minute). A token added to the vault has no numbers until the
  next poll ("no numbers yet", [vault.md](vault.md) section 4 "3a"); Refresh usage (below) gets them at once.
- `system_status` uses the numbers as they are when they are under one interval old, and starts a poll when they are
  older (the last poll failed, or its timer was held up).
- **Refresh usage** under the meters (`POST /api/usage/refresh`) polls every vault token now, and still asks each connected
  daemon for its login (`usage_now`; that login is not listed, see above), unless a poll is running or started seconds ago. The next scheduled poll then
  counts from it.
- A request that never answers cannot hold the polls up: each gives up after 75 s, and a poll still marked running
  after 5 minutes no longer blocks the next one.
