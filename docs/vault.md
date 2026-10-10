# The token vault (w512)

The portal keeps the secrets worker runs need: Claude subscription tokens, a GitHub token, the Discord bot token and any
other named secret. It hands each run only the ones that run may have, as environment variables, over the
authenticated daemon link it already uses. A worker machine keeps one credential of its own, its machine token, so a
new machine needs only its install plus that credential.

lothsahn asked for it (w512): "I would like the portal to store a list of claude tokens and any other tokens the workers
need so that it can pass it out securely to the workers in the cluster at runtime. This will break the tie of a token to
a box and make it faster and easier to install new workers."

- **Code:** `server/vault.ts` (the store, the choice of Claude token, what a run gets), `server/vaultCli.ts` (what
  fffctl runs), `server/machineTokens.ts` (machine credentials), `machineRunEnv` and redaction in `server/secrets.ts`,
  `githubCredentialEnv` in `server/launch.ts`, the `/api/vault` routes in `server/index.ts`, the vault section of the
  settings dialog (`web/src/components/Vault.tsx`), `fffctl vault` and `fffctl machine-credential`
  (`deploy/vm/guest/fffctl`), and `LoadCredential=` in `deploy/vm/guest/units/fff-portal.service`.
- **Off until switched on.** Merging this changes no machine. Claude tokens come from the vault only on machines that
  config `machines.claudeFromVault` names, and the other secrets only where an entry is granted. The steps are in
  [Cut-over](#cut-over).

## 1. Inventory: every secret a worker or its daemon uses

Paths and code come from w511's map (`docs/worker-root.md`, ff-factory #135, measured on BEAST) and from this repo.
**Moves** means it goes into the vault. **Stays** means it stays where it is, with the reason.

| Secret | Who uses it | Where today | Decision |
|---|---|---|---|
| Claude subscription OAuth tokens (`sk-ant-oat01-…`, `claude setup-token`) | every worker and standing run | config `claudeEnv.CLAUDE_CODE_OAUTH_TOKEN` (the host token), `userClaudeEnv` (people's own), a machine's own `/login` (`~/.claude/.credentials.json` or the Keychain), BEAST's `~/.claude-worker-token` | **Moves**: kind `claude`, one chosen per run ([section 4](#4-which-claude-token-a-run-gets)) |
| The workers' GitHub token (push, PRs, `gh`) | every worker | gh's login in each machine's keyring (BEAST: Windows Credential Manager, git's helper `gh auth git-credential`; measured in w511) | **Moves**: kind `github`, given as `GH_TOKEN`, plus a git credential helper that reads it (`githubCredentialEnv`). One fine-grained token per person (lothsahn, 2026-10-06; section 10), used where `machines.githubFromVault` is on ([section 13](#13-github-tokens-per-person-w868)) |
| Max's Discord bot token (the ffdiscord CLI's reads and writes) | runs that use the `ffdiscord` CLI directly (LothDesktop's today); posting as Max no longer needs it: `post_as_max` has FFBox post (w901) | `~/.config/ffbox/secrets.env` and `config.json` on LothDesktop | **Moves**: kind `env`, `FFDISCORD_APP_TOKEN`, granted to the posting machine only. *Measured:* `ffdiscord.py:9,236-238` (ff-discord plugin) reads `FFDISCORD_APP_TOKEN` from the environment before any file. `FFDISCORD_SERVER_ID` is not a secret and stays in the machine's config |
| Any other API key a run needs later | as granted | — | kind `env`, any variable ending `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD` |
| The machine token (`ffm_<id>_…`) | the daemon, to reach the portal | `daemon.json` (w511 moves it to `secrets/machine-token`) | **Stays**: it is the enrollment credential, the one thing a machine must hold to be given anything |
| The outside watch's ntfy topic | the M5's daemon | `outside-watch.json` in the daemon's folder | **Stays**: it must raise the alarm while the portal is down, so it cannot depend on the portal. The portal already sends it (`outside_watch`); the machine keeps the copy |
| ssh keys (`~/.ssh`: peer runs, the portal's deploy key) | lab and audit scripts, `add_machine` | each machine's `~/.ssh`; the VM's `/srv/fff/home/.ssh` | **Stays**: a key is tied to the peers' `authorized_keys`; the deploy key is the portal's own |
| Unity's licence activation | the editors | each machine | **Stays**: Unity binds it to the machine |
| The self-hosted GitHub runner's registration (BEAST, `finalfactory-mode2-windows`) | the game repo's CI | `C:\Users\rydin\actions-runner-finalfactory-mode2\` | **Stays**: GitHub's runner, outside FF Factory |
| steamcmd's login cache (M5, `~/.steamcmd-home`) | last-resort manual uploads (`mp-beta-deploy`) | the M5 | **Stays**: a person's own login, used by a person (w511 5.1); releases go through ffbox CI |
| FFBox's config and secrets (`~/.config/ffbox`, its connector token) | FFBox | FFBox's host, LothDesktop | **Stays, never shared**: the "nothing shared with FFBox" rule (D8) |
| `AgentControl/session-*.json` bearer tokens | the game's agent automation | the game's data folder | **Stays**: the game makes one per session, for local use only |
| The portal's own: its GitHub token (D7; since w868 its reads for a request use that request's person's vault token where `machines.githubFromVault` has `portal` on, section 13), Lothsahn's subscription token for the orchestrators (D4, `claudeTokenFile`), its Discord token copy, web-push keys, API keys | the portal | `/srv/fff/secrets`, `/srv/fff/home`, `data/` | **Stay as they are**: no worker uses them. The orchestrators could move onto vault tokens later ([section 9](#9-follow-ups)) |

## 2. The vault on the portal

**One file, `data/vault.json`, sealed value by value.** Each entry keeps its metadata in the clear (id, name, kind,
owner, grants, fingerprint, last four characters, dates, and which key sealed it). Its value is AES-256-GCM ciphertext with a fresh 96-bit IV,
and the entry's id and kind as additional data, so a value moved to another entry fails to open. Listing needs no key;
only handing a value out does. The file is written atomically (`writeJsonDurable`, mode 0600, no old generations kept,
so a removed value leaves no copy) under a lock file, and re-read when its modification time changes, so
`fffctl vault` can change it while the portal runs.

**The key lives outside the data folder.** It is 32 random bytes, base64, in one file:

- **In the VM:** `/etc/fff/vault.key`, `root:root 0600`, made by the guest installer (or `fffctl vault init`).
  `fff-portal.service` hands it to the portal with `LoadCredential=fff-vault-key:/etc/fff/vault.key`, so the `fff` user
  reads it only through `$CREDENTIALS_DIRECTORY` while the service runs. An empty `SetCredential=` is the default, so
  the portal still starts while there is no key yet. *(Sourced: systemd.exec(5), "Credentials": "SetCredential= will
  act as default if no credentials are found by any of the former"; the data sits "at a read-only location that (if
  possible and permitted) is backed by non-swappable memory".)* The portal reads the variable once at start and removes
  it from the environment its agents inherit.
  **The credential's mode (w736).** The portal's `fff` account is not root, so systemd writes the credential 0400,
  root-owned, and gives `fff` read access with a POSIX ACL entry (`user:fff:r--`) on the file and on its folder
  `/run/credentials/fff-portal.service`; where the file system has no ACLs it chowns the file to `fff` instead
  *(sourced: systemd's `src/core/exec-credential.c`, `write_credential`: `fchmod(fd, 0400)`, then
  `fd_add_uid_acl_permission(fd, uid, ACL_READ)`, else `fchown`)*. `stat` shows an ACL's mask in the group bits, so the
  file read `mode 440` although no group can read it *(measured, Ubuntu 24.04, systemd 255: `setfacl -m u:nobody:r` on a
  0400 root file gives `stat` mode 440, owner 0:0, and `getfacl` `group::---`, `mask::r--`, `other::---`)*. The old check
  (any group or other bit refuses the key) read that as "readable by other users" and the vault could not be used
  (`system_status`: "Token vault: 0 entries; key unreadable"). A mode set by a unit is not an option: `LoadCredential` has none.
  So `readKey` knows the credential: when the key comes from `$CREDENTIALS_DIRECTORY` (`keySource` marks it), the file must
  be directly in that folder (no link out), a regular file, with no *other* bits and no group or other *write* bit, owned by
  root or the portal's own account, in a folder with no other bits and the same owners. The group bits are not read as a
  grant there. Any other key file (config `vault.keyFile`, `/etc/fff/vault.key`) keeps the strict rule: no group or other
  bit at all.
- **Elsewhere** (a portal still on Windows, the e2e tests): config `vault.keyFile`. `loadConfig` refuses one inside
  `data/`; `readKey` refuses one that any group or other user can read (Linux, macOS).
- **No key, or the wrong one:** the vault still lists, but hands out nothing it cannot open. Every run falls back to
  what it had before (section 4) and `system_status` says why, naming the entries sealed with another key. Rotating an
  entry re-seals it with the current key.
- **Never in a backup:** `fff-backup` packs `/srv/fff` only (`tar -C "$FFF_ROOT"`, `deploy/vm/guest/fff-backup:36`).

**Adding, rotating and removing.** There are two ways in, and neither goes through chat:

- `sudo fffctl vault add|rotate|grant|remove|list` in the VM. A value is read from a file (`--file`) or stdin, never
  the command line, where any process could read it. Root's writes are handed to the `fff` user. For a person's Claude
  token there is a short form, `sudo fffctl vault add-claude <person> [<name>]` (hidden prompt or stdin; section 12.1), and
  what is added in the VM is copied to the FFBox host at night (section 12.2).
- The owner's settings dialog (Settings → Token vault), backed by owner-only routes (`/api/vault`). A member gets 403.
  An API key cannot reach them: `/api` takes only a signed-in browser session.

**One value per variable.** When two entries granted to a run give the same variable (two GitHub tokens), the run's
person's own entry wins, then the first by name.

**A value is never shown back.** Everything that lists the vault shows its name, kind, owner, grants, fingerprint and
last four characters. The fingerprint is the first 12 hex characters of the value's SHA-256, the same key the usage
meters use for a Claude token (`tokenKey`, `server/usage.ts`). No route, tool or command returns a value. The
orchestrators get no vault tool; `system_status` gets one summary line.

**Kinds:**

| Kind | Value | Given to a run as |
|---|---|---|
| `claude` | one `sk-ant-oat01-…` token | `CLAUDE_CODE_OAUTH_TOKEN`, one per run, chosen by section 4 |
| `github` | a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) | `GH_TOKEN`, and a git credential helper for `https://github.com` that reads it, on machines `machines.githubFromVault` names (section 13) |
| `env` | any value of 8 to 4096 characters, no whitespace | the entry's variable, which must end `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD` and may not start `CLAUDE_`, `ANTHROPIC_`, `GH_`, `GITHUB_` or `GIT_` |

**Grants.** Each entry names the roles it serves (`workers`, `standing`), the machines (`*` or ids), an owner (a portal
user id) and who may use it: `share: owner` (only work its owner asked for, the default) or `share: anyone`.

## 3. Distribution

**Enrollment is the machine token.** Each daemon already proves who it is with its own 256-bit token on the WebSocket
(`/machine`). The portal keeps only its SHA-256 and compares in constant time (`MachineManager.authenticate`). It is
per machine and revocable:

- `fffctl machine-credential issue <id> --out FILE` writes a fresh credential for a machine to a 0600 file and never
  prints it (for w513's installer). A daemon still connected with the one before is dropped within 20 s, so replacing
  a leaked credential cuts it off at once. `add_machine`'s deploy mints one too, but stages it beside the machine's
  current one (`next:<id>` in `machine-tokens.json`, w568): both work until the machine's daemon connects with one, and
  that one stays. A deploy that fails before its install step drops the staged one, so the machine keeps the token it
  has. Before w568 the new token replaced the old at once, and a redeploy whose ssh step failed left the machine with a
  token the portal no longer took at its next reconnect.
- The portal and fffctl both change `machine-tokens.json` (and `vault.json`) only under a lock file, so neither loses
  the other's change, and fffctl's files reach the `fff` user before they are renamed into place.
- `fffctl machine-credential revoke <id>`, or ✕ beside the machine in the vault dialog, deletes the hash. The portal
  drops that machine's open link at its next heartbeat, within 20 s (`MachineManager.dropRevoked`), and refuses its
  reconnects. The machine's record, sandboxes and sessions stay, so issuing a new credential brings it back.

**The secrets travel in the launch spec.** The portal already sends each new agent process its launch spec over that
link, with the Claude token in `spec.env` (docs/machines.md, "Claude account"). The vault fills the same field:
`machineRunEnv` (`server/secrets.ts`) works out a run's environment from its machine, its role and the person it is for,
and the spec builders (`machineWorkerSpec`, `machineSandboxSpec` in `server/agents.ts`; the machine branch of `place`
in `server/standing.ts`) put it in the spec. So:

- **Pushed per process start.** Every agent process on a machine starts from a portal `send`, which carries the spec.
  A daemon has nothing to ask for, and cannot ask for anything the portal did not decide to give that run.
- **Environment only, no files.** Every secret in the inventory is read from an environment variable by the tool that
  uses it (Claude Code, gh, git through the helper, ffdiscord). Nothing is written on the machine, so nothing needs
  wiping: the values live in the daemon's memory for that session and in the agent process's environment, and end
  with them. w511's `secrets/` folder keeps only the machine token.
- **Git without a stored credential.** For a run with `GH_TOKEN`, `buildOptions` adds command-scope git config
  (`GIT_CONFIG_*`) for `https://github.com` only: an empty `credential.helper` (which clears the helpers git would use
  otherwise) and one that answers `username=x-access-token`, `password=$GH_TOKEN` from the environment. *(Measured:
  `vault.test.ts` runs `git credential fill` with it on Windows and gets the token. Sourced: gitcredentials(7), "If
  `credential.helper` is configured to the empty string, this resets the helper list to empty".)*
- **Only what that run may have.** A run gets one Claude token and the other entries granted to its role and machine
  (a GitHub entry only where `machines.githubFromVault` is on, section 13). Another machine's grants never reach it.

**When the portal is down, nothing new starts.** That is how it already works: no portal, no `send`, no new process.
Running agents keep the environment they started with and carry on. There is no cache on the machine to steal or to
expire. When the portal is back, the next start gets current values, so a rotated token applies from then.

## 4. Which Claude token a run gets

A person's runs use **that person's own tokens, their pool, and nobody else's** (lothsahn, 2026-10-08: "each operator is
only going to use its own pool going forward--except for the dispatcher"). The pick is `pickPool` (`server/tokenPool.ts`,
pure functions), called from `Vault.forRun` (`server/vault.ts`) at every process start, resumes included.

**Whose pool.** The run's person: its requester, else the system payer (config `systemPayer`, else the owner) for work
nobody asked for by name; `vault.unattributed` (section 10) names whose pool intake, FFBox and nightly work use. A Claude
entry with no owner (`share: anyone`, added by hand before the pool) is in nobody's pool and is never handed out:
`fffctl vault list` names it as "not in any pool". A shared Claude token was **retired** from the pick; GitHub and env
entries are unchanged. A worker or standing agent also needs the entry granted to its role and machine (`roles`,
`machines`); the ops worker takes the workers' grants on no machine; a person's orchestrator takes no grant (the
account setting is its consent).

**The order.** The token whose **weekly** window resets soonest first (it is the capacity that would otherwise be lost
at the reset), the 5-hour reset as the tie-break, then the name. A token with no reset time yet goes last. The 5-hour
window refills every five hours whatever is done, so ranking by it would save nothing; weekly is the default key.
The meters are the ones `UsageTracker` polls (section 4a).

**The limits** (one system-wide set, config `vault.pool.*`, percent 0 to 100, defaults below; **anyone** may change them
with `set_app_config`, not only an owner; the one-at-a-time limit may not be above the retire limit; each change is
logged in the portal journal with who made it; they apply at the next process start, no restart):

| Key | Default | A token at or past it |
|---|---|---|
| `vault.pool.sessionHoldPercent` | 80 | its **5-hour** meter: no new process on it until that window resets |
| `vault.pool.onePerWeeklyPercent` | 95 | its **weekly** meter: **one** live process at a time |
| `vault.pool.retireWeeklyPercent` | 99 | its weekly meter: **retired**, handed to nobody until the weekly window resets |
| (at 100) | | either meter: **used up**, handed to nobody until it resets (a rejection by the API counts as 100) |

A token with no numbers yet counts as 50% on both meters, so it passes every rule and ranks last. "Live" counts the
sessions whose process started on the token, not the asking session itself, and a pick made in the last 20 seconds before
its process shows (two starts cannot both take the last slot).

**Sticky per session.** A session keeps its token only while the token still passes these checks; otherwise it moves to
the next. The choice is made at each process start, never mid-process.

**When the pool has no token that may serve the run** (every one held, one-at-a-time with a process running, retired or
used up):

| Role | What happens |
|---|---|
| A worker, a standing agent, the ops worker for them | **Held** with the reason ("lothsahn's Claude token pool is held: every token is at a limit (a: 5-hour 90% (>= 80): held until Fri 14:00Z; b: …): the first frees up Fri 14:00Z"): a worker's first prompt queues and is tried again, a standing agent's run ends "Could not start: <reason>" and the next scheduled run tries again; no fallback to the host token, the machine's login, the dispatcher's token or anyone else's |
| A person's own **orchestrator** (`claudeAccounts.orchestrator = "vault"`) | **Uses the pool up**: while some token is only past its caps (held, one-at-a-time, retired) but not used up, it runs on the one with the most room (the soonest reset on a tie), and the one-at-a-time rule does not bind it. Once every token is used up it **stops** with the reason and the next reset on the dashboard; there is no override and no fallback |
| The **dispatcher** | Never on a pool: it keeps the shared token file (or whatever `claudeAccounts.dispatcher` names) and is never held |

**What a token at the one-at-a-time limit is (w747).** A token at 95% weekly is not over its cap: it still works, one
process at a time, until 99%. Its line says so with the room left and whether the slot is free: `weekly 95%, one job at a
time until 99%: 4% left before it stops; the slot is taken now (1 running)` (or `...; the slot is free`, and then it is
`ok`: a new job takes it). The same words are in `system_status`, `fffctl vault list` and the queue's "held" reason. "At a
limit" and "wait until the reset" are said only when every token is held or retired; "used up" only when every token is at
100% or rejected.

**The banner at the top of the dashboard (w747).** A pool warning is shown only to the person whose pool it is (the server
sends each connected page only its own: `warningsForUser`, `hostForUser`); the owners still see every pool in
`system_status` and on the accounts page. It appears only when **no** token of that person can take new work: every one held
or retired ("Every one of your Claude tokens is at a limit (...). New work waits until the first one frees up (Fri 14:00Z).")
or every one used up ("All your Claude tokens are used up (...) ... and the orchestrator is stopped; there is no override.").
A token that is merely busy with its one job (`slot-taken`) shows no banner: the next job starts when the running one
finishes, which the queue's "held" reason says. The banner about the dispatcher / host-token reserve (`reserve:…`, no person)
is for **everyone logged in**, as before.

**The transition.** A person with **no** Claude token in the vault keeps today's account, so nothing stops at deploy:
the machine's login or the host token for their workers (`machines.useHostClaudeEnv`), the token file for their
orchestrator and for the ops worker working for them. `system_status` warns ("no vault Claude token for a workers run
on m3 for sam; it runs on host token …abcd instead") for 24 hours. The same fallback applies when the vault cannot open
their tokens (no key, a wrong key): nothing the person can wait for. The moment a person has one token, only their pool
is used.

**The dispatcher's reserve.** The credential the dispatcher runs on (`claudeAccounts.dispatcher`, resolved from config
at each look: the token file today, else the host token or this host's login) and the host token
(`claudeEnv.CLAUDE_CODE_OAUTH_TOKEN`, which biscuit's agents and any person without a pool run on) keep a buffer for
their own roles: **5% of the weekly window for each day left until that window resets** (35% with seven days to go, 5%
with one, 0 at the reset; `vault.pool.reservePerDayPercent`) and **20% of the 5-hour window**
(`vault.pool.reserveSessionPercent`). The reserve is the dispatcher's: it may always run into it, up to 100%, and
nothing checks it before the dispatcher starts. Nothing else is *refused* by it, because after the pool change nothing
else lands on these credentials except a person with no vault token yet (their orchestrator, the ops worker for them),
who has no other account; `system_status` shows each reserve ("the dispatcher's token file …dAAA: weekly 41%, reserve
25% (5 days to reset); 5-hour 12%, reserve 20%") and, while a meter is inside the buffer with such runs on the credential,
the dashboard shows a warning. Both the status line and the warning name only the limit or limits that put the token inside the
buffer, each with its figure, its buffer and its reset ("5-hour 93% (buffer 20%), resets in 10 min"; both, when both are inside;
`reserveReason` in `server/tokenPool.ts`): the week is never given as the reason while it is outside its buffer (w828). Until a
credential's first reading arrives it counts as inside its reserve, and the text says "no reading yet". One token is
one account: two tokens of one Claude account are not matched, so such a token would have its own meters and its own
reserve.

**Order with the existing switches.** A person's own token in config `userClaudeEnv` still wins for their work on a
machine, as before. Then the vault, on machines `machines.claudeFromVault` names (owner-only in `set_app_config`;
per machine with `machine: "<id>"`, section 6). A vault token is given with `LaunchSpec.login` set, so the daemon
drops its own environment's credentials (an `ANTHROPIC_API_KEY` there would outrank the token) and the token is the
process's only one. A person's orchestrator on `"vault"` and the ops worker work the same way, in the portal: the one
token as `CLAUDE_CODE_OAUTH_TOKEN`, every other Claude credential removed first.

### 4a. Where the numbers come from, and how stale they are

- **The usage endpoint** (`/api/oauth/usage`) needs the `user:profile` scope. A token from `claude setup-token` has only
  `user:inference` and answers **403** *(sourced: community reports of the same 403, e.g. claude-code issues 22450,
  24200; measured on the dispatcher's token file by lothsahn, 2026-10-09)*. Re-issuing cannot add the scope: it is fixed
  in the CLI's authorization URL, and an interactive `/login` token that has it rotates its refresh token, so it does not
  suit unattended use.
- **The rate-limit headers** of any `/v1/messages` reply (`anthropic-ratelimit-unified-5h-*`, `-7d-*`: utilization as a
  fraction, reset as epoch seconds) carry the same two windows and need only `user:inference`. FFBox reads usage this
  way for its setup-tokens (*sourced:* `scripts/claude_keys.py` in Final-Factory/ffbox, commit 57c35a5b4b, which says
  the 403 was "measured 2026-09-04" and the headers answer; it takes them from a one-token Haiku call and from a 429
  reply too). `fetchTokenLimits` does the same here. It already ran when the endpoint answered 429; it now also runs on
  **403**, and the endpoint is not asked again for that token for six hours. It costs one Haiku request with one output
  token. Not measured here with an inference-only token: the first poll after the deploy logs `via the API's rate-limit
  headers` for it.
- **The SDK's `rate_limit_event`** (from the same headers on a running session's own requests) raises a token's meter
  between polls and never lowers it (a guess at its frequency and scale; it is a floor, the next poll replaces it).
- **How stale:** the regular poll is every `usagePollMinutes` (15). A token near a limit (5-hour at 60% or more, weekly
  at 90% or more, or with no numbers) is also polled alone every **2 minutes**. How far a token can overshoot a limit in
  an interval depends on the work on it and was **not measured** (no poll history existed to measure from): every poll
  logs the percentages (`usage: … Weekly 41%, Session 33%`), so a week of the journal gives the largest rise per interval.
  Between polls a pick can be a few percent stale; the caps leave 20% of the 5-hour window and 1% of the week for it.

## 5. Security review

| Threat | What stops it |
|---|---|
| A worker machine is compromised | It holds only its machine token. With it, it receives what the portal sends its runs: the Claude token chosen for each, and the entries granted to that machine. It cannot list the vault, ask for an entry, or see another machine's grants. Revoke the machine (one command) and rotate what it was granted; the vault shows exactly which entries name it |
| An agent on a worker machine reads its environment | It sees its own run's secrets, as today (it must, to use them). The vault narrows that from everything in the machine's keyring to what its run needs |
| The data folder leaks (a backup, `fffctl migrate`, a copy) | `vault.json` holds ciphertext; the key is never in `data/` or a backup |
| An orchestrator on the portal (the same OS user) goes for the key | The secret guard refuses reads of `vault.keyFile`, `/etc/fff`, `/run/credentials` and `$CREDENTIALS_DIRECTORY` (`portalSecretRules`), as it refuses `data/` and the token file, and the variable is removed from the agents' environment. This is a seatbelt, not a boundary: a shell command of the same user can still read the credential while the service runs. The boundary is the one D2 accepted |
| A value reaches a log, a transcript or chat | No route, tool or command returns one. Transcripts, the daemon log and the portal log redact Claude, GitHub, provider and Discord tokens by pattern, and every vault value by value, whatever its form: the portal learns them from the vault and each daemon from the launch specs it gets (`addSecretValues`). A rotated or removed value stays on the list, because a run started before still holds it. Errors name entries, never values |
| Someone asks an agent in chat to add or print a token | There is no tool for it. Values enter through fffctl (root in the VM) or the owner's own browser session |
| FFBox | Nothing is shared: no FFBox secret is in the vault, and no vault value goes to FFBox |
| The FFBox host's root | Can read the VM's memory and disk (D2, accepted with mitigations). The vault keeps the values out of `config.json` and `data/`; it does not change that boundary |

**What reaches a worker machine:** the machine token on disk, and, for the life of each agent process, that run's
environment. Nothing else.

## 6. Migration

Each step can be undone on its own. The commands are in [Cut-over](#cut-over).

1. **Build the vault in the VM, after the portal's cut-over (w508).** The key is made in the VM; `vault.json` is in
   `data/`, so a later `fffctl migrate` carries it; the FFBox host keeps the tokens and the key's spare copy (sections 8, 11). Do not fill a
   vault on BEAST's portal: its key would have to be carried across by hand.
2. **Enter the tokens:** each person's Claude and GitHub tokens on the FFBox host, then `fff-vm vault-sync` (section
   11); Max's Discord token in the VM with `fffctl vault add`.
3. **Switch one machine at a time:** `set_app_config machines.claudeFromVault true machine: "<id>"`, m3 first, then
   m5, LothDesktop, BEAST. Its next agent process runs on a vault token; running ones keep theirs. `machine` is what
   keeps the others as they are: `{ key: "machines.claudeFromVault", value: true, machine: "lothdesktop" }` writes
   `"claudeFromVault": { "lothdesktop": true }` and nothing else changes. Without `machine` the value is the default for
   every machine not named (`true` switches all of them). The setting is live (the server's config object), needs no
   portal restart, and is read when each agent process starts, so a machine that is offline needs nothing pushed: its
   next process, after it reconnects, takes the vault path (w737). If the vault cannot give a token (the key is
   unreadable, or no entry is eligible for the run's person) the run is not refused: it falls back to the host token or
   the machine's own login and `system_status` warns for 24 hours (`machineRunEnv`, `server/secrets.ts`).
4. **Grant the other secrets** to that machine, then check that a worker there can `gh auth status` and push, and, on
   the posting machine, that `ffdiscord` posts.
5. **Retire the machine's own logins** only after it has run on the vault for a while with no fallback warning:
   `claude /logout` and LothDesktop's Discord token in `secrets.env`. Until then they are the fallback. **Keep the
   machine's `gh` login** (w868): the daemon's own fetches (a new sandbox, the base refresh) and the pushes of a branch
   handover still use it (section 13.3).

**Rolling back:** `set_app_config machines.claudeFromVault false machine: "<id>"`, and take the machine out of the
grants. Its next process runs on its own login or the host token again.

**w510** (the portal no longer runs workers): every worker then runs on a machine through a daemon, the only path the
vault serves, so there is no host-worker branch to keep. **w511** (one worker root): its `secrets/` folder keeps only
the machine token; the Claude token, `gh-token` and bot configs it planned to copy in come from the vault, so the
installer needs no secret but the machine credential. **w513** (the installer): it asks for that credential
(`fffctl machine-credential issue <id> --out FILE` in the VM) and nothing else.

## 7. Sharing one subscription token across several machines

**The question:** may one Claude subscription token (`claude setup-token`) run agents on several machines at the same
time?

- **Mechanically, yes** *(sourced)*. Claude Code's [authentication docs](https://code.claude.com/docs/en/authentication)
  ("Generate a long-lived token") describe `claude setup-token` as "a one-year OAuth token for CI pipelines, scripts, or
  other environments where interactive browser login isn't available", to set "wherever you want to authenticate".
  Neither that page, the [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page nor the
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective 2025-10-08, read 2026-10-06) limits the
  number of machines or concurrent sessions *(searched: those three pages)*.
- **Automation is allowed for this credential** *(sourced)*. The Consumer Terms forbid access "through automated or
  non-human means … except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly
  permit it". The setup-token docs explicitly permit CI pipelines and scripts, and the legal page says the plan limits
  "assume ordinary, individual usage of Claude Code and the Agent SDK".
- **The limits are per account, not per machine** *(measured)*. The usage endpoint answers one 5-hour and one weekly
  window per token's account (`parseUsage`, `server/usage.ts`), and the meters already show one account used from
  several machines (the host token on BEAST and the Macs). Several machines on one token share one budget; section 4
  spreads runs across the accounts.
- **The real constraint is whose work it is** *(sourced, with a guess on how it applies)*. The Consumer Terms: "You may
  not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may
  not make your Account available to anyone else." A token running its owner's own agents on the owner's machines is
  the owner's own use. A token running work someone else asked for is, on a plain reading, making the account
  available to someone else. *Guess:* whether two people building one game together count as "anyone else" is not
  settled by the terms. So entries default to `share: owner`, and sharing is the owner's explicit choice for their own
  token. The documented routes for shared team use are a Team plan (a seat per person) or API keys under the Commercial
  Terms.
- **Enforcement** *(sourced)*: "Anthropic reserves the right to take measures to enforce these restrictions and may do
  so without prior notice" (legal page). Round-the-clock multi-agent use may be judged beyond "ordinary, individual
  usage" *(guess: no threshold is published)*.

**Answer:** one token on several of its owner's machines at once is fine *(sourced)*. One token serving other people's
work is the risk; lothsahn decided each person's tokens serve only their own work (section 10).

## 8. Moving the portal (w508) and backups

- **The FFBox host is where the tokens live** (lothsahn, 2026-10-06; [section 11](#11-the-tokens-on-the-ffbox-host)).
  The VM's vault is filled from there by `fff-vm vault-sync`, so a rebuilt or moved VM gets them back from the host.
  What is added in the VM is copied to the host every night, so the host is the full backup ([section 12](#12-adding-in-the-vm-and-the-nightly-copy-to-the-host-w749)).
- **Not in the VM's daily backup:** `fff-backup` leaves `data/vault.json` out (`--exclude='data/vault.json*'`), and the
  key was never in it (`/etc/fff` is not under `/srv/fff`).
- **The key's spare copy** is `/etc/fff-vm/secrets/vault.key` on the host, kept in step with the VM's key by every
  `fff-vm vault-sync` (the one before kept as `.prev`). Entries added by hand in the VM (Max's Discord token, say) are
  copied to the host's `vault-extra/` at night and put back by the sync; they open again after a rebuild once root puts that
  copy back:
  `sudo sh -c 'fff-vm ssh "sudo install -m 0600 /dev/stdin /etc/fff/vault.key" < /etc/fff-vm/secrets/vault.key' && sudo fff-vm ssh 'sudo fffctl vault init'`.

## 9. Follow-ups

- **Built (w738, w739):** the orchestrators on vault tokens, a `"vault"` value for `claudeAccounts.orchestrator`: each
  person's orchestrator, and the ops worker working for them, runs on that person's pool (section 4); the token file stays
  the dispatcher's and the fallback for a person with no vault token. Retiring `claudeTokenFile` entirely would put the
  dispatcher's token in the vault too: not done.
- The meters attribute a stopped vault session of an orchestrator by the token it ran on last (`Vault.lastPickOf`,
  this portal run); a worker's stopped session by the current config rather than the token it ran on, as for every
  account (`sessionSource`); live sessions are exact.
- A dedicated OS user for the portal's own agents would make the key boundary real rather than a seatbelt (section 5).
- The seal authenticates a value with its entry's id and kind, not its grants: someone who can write `data/` (the
  portal's user) could re-grant an entry. Sealing the grants too would make every grant change need the key.

## 10. Whose tokens

lothsahn's decision (2026-10-06): "I would like the portal to hand out my Claude and GitHub tokens for requests from my
orchestrator and the same from Ben's." And for work nobody asked for by name: "Intake should be my token. Nightly sentry
Ben. Ffbox me unless it provides an operator... In that case, use the token of the operator."

**The rule.** A worker run gets the Claude token and the GitHub token of the person its work is for, and nobody else's:

| The run | Whose tokens | Where the code decides |
|---|---|---|
| A request a person filed (their orchestrator's `request_work`, a trusted Discord request to Max) | that person's | the run's `requestedBy` (`machineRunEnv`) |
| A worker a person's orchestrator started directly | that person's | the same (`actingFor`, the author of the message it serves) |
| A request both people asked for (one merged into the other) | the person who filed it first | `WorkItem.requestedBy`; a merge adds people to `requesters` only (the merge in `Orchestrators.decide`, `server/orchestrators.ts`), and the dispatcher's `work_id` starts run as `requestedBy` (`dispatcherActor`). *Why:* it is the one requester the ledger already bills and attributes the request to; picking per run among `requesters` would make two runs of one request land on different accounts |
| Intake work nobody named: Discord bug reports, FFBox reports and diagnoses, release follow-ups | config `vault.unattributed.intake`, default `lothsahn` | `WorkItem.unattributed` (set by `fileIntake` when no person asked), `unattributedKind`, `tokenPersonForWork` |
| FFBox-filed work naming no operator | `vault.unattributed.ffbox`, default `lothsahn` | the same |
| FFBox work naming an operator (an ffdev dev request, an operator's escalation) | that operator's, mapped to the FF Factory login of the same name | the request is filed for them (`fileDevRequest` from `server/devRequests.ts`; an operator's escalation in `server/intake.ts`), so it is not unattributed |
| The nightly lab's reports, the nightly regression sentry and the workers its delegations start | `vault.unattributed.nightly`, default `ben` | `unattributedKind` (source `nightly`, or a delegation from `nightly-regression-sentry`); the sentry's own runs in `server/standing.ts` |
| Anything else no person asked for | the system payer's (config `systemPayer`) | `machineRunEnv` |

The token person changes only which vault entries a run gets. Who a request is billed to in the ledger, who hears
about it, and the usage attribution stay as they are.

**Tokens are not shared across people.** Every per-person entry is `share: owner`. A run whose person has no token in
the vault gets nobody else's: it runs as it did before the vault (the machine's own login or the host token), and
`system_status` warns. Change the defaults with `vault.unattributed` in `config.json`, e.g.
`"vault": { "unattributed": { "intake": "lothsahn", "ffbox": "lothsahn", "nightly": "ben" } }` (user ids).

## 11. The tokens on the FFBox host

**Where:** on the FFBox host (Loth2400), root only, beside what the VM installer already keeps:

```text
/etc/fff-vm/secrets/                     0700 root
  people/<user id>/claude-token          0600: one 'claude setup-token' token (sk-ant-oat01-...)
  people/<user id>/claude-tokens/<name>  0600: more of them, one token per file: the person's pool (w739); 0700 folder
  people/<user id>/github-token          0600: one fine-grained GitHub token (github_pat_...)
  vault.key                              0600: the spare copy of the VM's vault key
```

`claude-token` stays and is a pool of one. A `<name>` is 1 to 16 of `a-z 0-9 . _ -`, starting with a letter or digit
(upper case is read as lower). Each file is an entry `vault-<user>-<name>` (`claude-token` is `vault-<user>`); all of a person's Claude entries are
their pool (section 4).

**How the VM gets them: pushed in, not shared.** `sudo fff-vm vault-sync` (`deploy/vm/host/vault.sh`) sends each file
over ssh's stdin to `fffctl vault put` in the VM, as the installer already sends the Claude and GitHub tokens
(`push_secret`, `deploy/vm/host/guest.sh`). The entries are `vault-<user>` (claude-token), `vault-<user>-<name>` (claude-tokens/<name>) and `vault-<user>-github`, `share:
owner`, for workers and standing agents on every machine. A second run changes nothing; a new value rotates its entry; a
removed file removes its entry. An entry that exists only in the VM (added with `fffctl vault add-claude`) is copied to the host first and so is never taken for one whose file is gone. Entries not named `vault-…` or `host-…` (added by hand) are left alone (and copied to the host first: [section 12](#12-adding-in-the-vm-and-the-nightly-copy-to-the-host-w749)); two files that would make one name (a pool file called `github` beside a `github-token`) make one entry, the other is skipped with a warning. The installer's guest step
runs it too, so a re-run or a rebuilt VM is filled again.

*Why not a read-only virtiofs share:* it needs a new device in the VM's libvirt definition and a cold restart of the
VM; while mounted, every file in it is readable from inside the VM by root and anything root runs, at any time, rather
than only the values the vault was given; and the vault would need a second reader for it. The push needs nothing new
on the host and reuses a path the installer already uses and CI already tests.

**Checks before a value goes in:** a Claude token must be one `sk-ant-oat01-…` token; a GitHub token must be
fine-grained (`github_pat_…`). A classic `ghp_` token is refused: lothsahn asked for fine-grained tokens, one per person,
scoped to the Final-Factory repositories.

## 12. Adding in the VM, and the nightly copy to the host (w749)

lothsahn (2026-10-09): "I would also like a fffctl command that can be run in the VM that adds a key to the vault, and I
would like to update the nightly host vm restart process to copy any vault keys that exist within the VM to the host."

- **Code:** `vault_add_claude` in `deploy/vm/guest/fffctl` (the add), the `export` case in `server/vaultCli.ts` and
  `Vault.reveal` in `server/vault.ts` (the only way a value leaves the VM), `vault_pull`, `vault_target`, `vault_fetch`,
  `vault_restore_extras` and the changes to `vault_sync` in `deploy/vm/host/vault.sh`, `nightly_vault_copy` and
  `fff-vm vault-pull` in `deploy/vm/host/fff-vm`. Tests: `deploy/vm/test/fff-vault-add.test.sh` (the add),
  `fff-vault-sync.test.sh` (the copy, the sync after it, the conflict rule, removal), `fff-vm-nightly.test.sh` case 11 (the
  copy comes before the drain), `ci-vm-e2e.sh` (all of it in a real guest), `server/vault.test.ts` (`export`).

### 12.0 The Claude account's email on the accounts list (w785)

A `claude setup-token` token cannot say whose it is, so the accounts list shows an email only when a person recorded one on the
entry (`VaultEntryMeta.email`, not secret, never read from the token). **Sourced, not measured** (no setup-token was available to
try; the vault's are not ours to use): the token is minted with `user:inference` alone (the CLI's `setup-token` login is
`inferenceOnly`, see the top of `server/usage.ts`); the profile and usage endpoints need `user:profile` and answer 403 for it
(claude-code issues 22450 and 24200); with `CLAUDE_CODE_OAUTH_TOKEN` set, `/status` and `~/.claude.json` `oauthAccount` show no email or
organisation (issue 90298, "no way to verify which org/account a setup-token token is scoped to"); the one owner-naming reply header found (documented for API keys, never seen for a token) is
`anthropic-organization-id`, an organisation id, not an address (Anthropic's API overview, headers). So the email
is whatever someone types, and is shown only then (nothing is shown, never a guess, when none is recorded). Set it:
- when adding: `sudo fffctl vault add-claude <person> [<name>] --email <address>` (on a terminal it asks, Enter skips), or Settings, Token vault,
  Add a token, "account email";
- afterwards, without the token: `sudo fffctl vault grant vault-ben-2 --email <address>` (`--email ''` clears), or Settings, Token vault,
  the entry's **Grant**, "account email". `fffctl vault put --email` does the same; `put` without `--email` (the host's sync) leaves it alone.
It is on the entry's subtext line on the dashboard and in `system_status` ("- vault-ben-2 …dAAA [ben@example.com; agents on it: …]"), before
the other uses of the same token (docs/accounts.md). It lives in the VM's `vault.json` only, which the daily backup leaves out (section 8): a rebuilt
VM needs it typed again.

### 12.1 Adding a Claude token in the VM

```bash
# on the FFBox host (a hidden prompt: -t gives the VM a terminal):
sudo fff-vm ssh -t 'sudo fffctl vault add-claude <person>'
# or in the VM, as its admin account:
sudo fffctl vault add-claude <person> [<name>]
```

`<person>` is the portal user id (`lothsahn`, `ben`). The token is typed at a prompt that does not echo it, or piped in on
stdin (`printf '%s\n' "$T" | sudo fffctl vault add-claude ben`); it is never an argument, so it is not in `ps`, in the shell
history or in a log, and a third word is refused for that reason. It must be one `sk-ant-oat01-…` token
(`claude setup-token`); anything else is refused and not echoed.

The entry is **`vault-<person>-<n>`**, where `<n>` is the next number no entry holds (a `host-<person>-claude-<n>` the host
still has to rename counts as held), or `vault-<person>-<name>` when a `<name>` (1 to 16 of `a-z 0-9 . _ -`, lower-cased) is
given. It is what `fff-vm vault-sync` makes from `claude-tokens/<n>`: the person's own (`share: owner`), for workers and
standing agents on every machine, so it is in their pool at once (section 4). A name that exists is refused; replacing a
token is `fffctl vault rotate`, and the host's file wins over that (12.4). A person with no entry before is said ("nobody
had a vault entry for 'x'"), so a mistyped user id is noticed; `sudo fffctl vault remove <entry>` takes it back.

**Other secrets** keep `sudo fffctl vault add --kind github|env … --file FILE` (or `--stdin`): the same rules (never the
command line, never shown back), and the nightly copies them too (12.2). Only Claude tokens have the short form, because
only they have a naming scheme the pool reads.

### 12.2 The nightly copy to the host

`fff-vm nightly` (12:00 UTC, `fff-vm-nightly.timer`) runs `nightly_vault_copy` **first**, while the VM is up and before it
drains the portal: every vault entry that exists in the VM and has no file on the host is copied to the host. It runs every
night whether or not the VM restarts tonight (`NIGHTLY_MODE=off` skips the whole nightly). It never holds the restart back
and never fails it: a problem is logged and sent as an alert (names and last four characters only). The same copy is
`sudo fff-vm vault-pull` by hand, and the first step of every `fff-vm vault-sync` and of the installer's own sync, so a sync
**never removes an entry that only the VM has**; when the copy cannot run (the VM's portal is not updated yet) the sync
removes nothing and says so.

| The VM's entry | The host's file (`/etc/fff-vm/secrets/`, files 0600 root, folders 0700) |
|---|---|
| Claude, `vault-<person>` | `people/<person>/claude-token` |
| Claude, `vault-<person>-<n>` (not `-github`) | `people/<person>/claude-tokens/<n>` |
| GitHub, `vault-<person>-github`, a fine-grained token | `people/<person>/github-token` |
| anything else: an `env` entry (Max's `max-discord`), a Settings-dialog entry, a classic `ghp_` token, a name that is none of the above | `vault-extra/<name>/value`, with its kind, variable and grants in `vault-extra/<name>/meta` |

*Why the others go to `vault-extra/` and not into `people/`:* `people/<id>/` is what `vault_sync` reads and pushes, and its
file names can say only a person's Claude or GitHub token. An env entry has a variable, a share and machine grants that a
file name cannot carry, and a classic GitHub token is what the sync refuses by design (section 11). `vault-extra/` is a
backup only: the sync never reads it into a person's pool. When the VM lacks an entry that has a copy there (a rebuilt VM),
`vault_restore_extras` puts it back with its grants (`fffctl vault put`); it only ever creates, and an entry the VM has is
never changed from the host.

**What the VM lists is not trusted.** `fffctl vault export --manifest` lists each entry's name, kind, variable, owner,
grants, fingerprint and last four characters, no value. The host checks every field against the pattern a vault entry can
have before any of it becomes a path or part of a command (a `../` in a name or an owner, a `;` in the grants: skipped and
said); fetches one value at a time with `fffctl vault export <name>`, straight into a 0600 file; checks its fingerprint
against the listing and its shape against its kind; and only then links it into place.

### 12.3 Security

- **Root to root, over what is already there.** `fffctl vault export` is the one command that prints a value. It refuses a
  caller that is not root and a standard output that is a terminal, so a value goes to a pipe or a file or nowhere
  (`server/vaultCli.ts`, `export`). The FFBox host's root runs it over the same ssh key and pinned host key as `fff-vm ssh`
  (`vssh`, `/etc/fff-vm/ssh/id_ed25519`, root's), and the value goes from ssh's output into a file made under `umask 077`.
  It is never an argument, an environment variable, a log line or the journal. D2 already lets the host's root read the
  VM's memory and disk (section 5); this copy puts the value in one more root-only place on that host and gives no one
  else a way to it.
- **Not read-only, and refused to everyone but a person.** `export` and `add-claude` are in `FFFCTL_FORMS.vault.changes`
  (`server/opsWorker.ts`), not `allowed`: the server's shell guard refuses them to the ops worker with a reason,
  `fff-ops-priv` has no case for them, and `server/opsFffctlForms.test.ts` fails if either is ever made allowed. w745's rule
  that no read-only command prints a value stands. **No portal route, API, MCP tool or orchestrator access:** `Vault.reveal`
  is called from `server/vaultCli.ts` only (`vault.test.ts` fails on a second caller, or one in the web app); no
  `/api/vault` route returns a value (section 2).
- **Logs carry names, the last four characters and fingerprints, nothing else.** The fingerprint is the 12 hex characters
  `fffctl vault list` shows already. The nightly's alert says the same. Example, as `journalctl -u fff-vm-nightly` shows it
  (the values here are made up):

  ```text
  fff-vm: vault: copied vault-ben-3 (…c2d8, fb5bd9bd1555) from the VM to /etc/fff-vm/secrets/people/ben/claude-tokens/3
  fff-vm: vault: copied max-discord (…e7Qa, 91c0d2a4be07) from the VM to /etc/fff-vm/secrets/vault-extra/max-discord/value
  fff-vm: vault: copy from the VM: 7 entries; 2 copied, 5 already here, 0 conflicts, 0 deleted here, not copied back, 0 old host-… names, 0 skipped
  ```
- **The VM is the less trusted side.** The copy only creates a file under a name the host has no file for (a hard link, so
  a file that appears meanwhile is not replaced); it never changes a person's file (12.4). A VM that lies can add token
  files for new names, as it could add entries; it cannot read a host file, overwrite one, or make the host run anything.
- **Where the copies rest** (not measured): the host files are as exposed as the `claude-token` files already there
  (root-only on the host, the same folder). Searched `deploy/` and `docs/` for a backup of `/etc/fff-vm`: none is
  configured in this repo; whether the FFBox host has one of its own is not known here.

### 12.4 When the host has a file and the VM has another value: the host file wins

Chosen: **the host file wins.** The copy never changes it. It logs the conflict (the VM's and the host file's last four
characters and fingerprints) and raises an alert, and the sync that follows rotates the VM entry to the host's value, as
`vault-sync` always did. Reasons: *(sourced from the code)* the host file is the place the runbook has always said to
rotate a token (Cut-over, "Rotating a token later"), and the sync has always made it win over the VM; *(reasoned)* a copy
that can only create cannot be turned by a mistake or a compromised VM into an overwrite of the host's backup; and the host
cannot tell which value is newer (a file's age and a VM entry's date come from two clocks).

The one case that costs something: a person runs `fffctl vault rotate vault-ben-2` in the VM, as the old token expired,
and the host still has the old one in its file. The nightly then logs and alerts the conflict, and the sync puts the old
token back. To keep the new one, put it in the host file (`/etc/fff-vm/secrets/people/ben/claude-tokens/2`) and run
`sudo fff-vm vault-sync`. `fffctl vault rotate` on a `vault-…` entry says this where it is done. **Extras are the other way
round:** they have no editor but the VM, so a changed value there replaces the host copy (the old one kept as
`value.prev`) and the VM wins.

### 12.5 Removing a token for good

The host's files are the backup, and a name the last sync found a file for is remembered (`vault-synced`, beside the keys):
an entry whose file is gone is a deletion, and an entry nobody has a file for is a new one.

- **A token with a host file** (made there, or copied by the nightly): delete the file, then `sudo fff-vm vault-sync`. The
  entry leaves the VM, and a nightly in between does not bring the file back. Revoke the token where it was made, too.
- **Added in the VM and not copied yet** (the same day, before 12:00 UTC): `sudo fffctl vault remove vault-<person>-<n>`
  in the VM. If it was copied, the line above.
- **Removed in the VM only:** it comes back at the next sync, from the host file. That is what the host copy is for.
- **An extra:** `sudo fffctl vault remove <name>` in the VM, and `sudo rm -r /etc/fff-vm/secrets/vault-extra/<name>` on the
  host (its value, `value.prev` and `meta`); otherwise the nightly copies it back or a rebuilt VM gets it back.
- A host that has never run the sync with this change has no `vault-synced`: an entry with no file is then taken for a new
  one and copied (the safe way round), until one sync has recorded the names.

### 12.6 Install (nothing runs until lothsahn does it)

On the FFBox host:

```bash
cd /opt/ff-factory && git pull
sudo deploy/vm/host/install.sh --guest-only            # the new fffctl (add-claude) in the VM, and fff-vm, vault.sh on the host
sudo fff-vm ssh 'sudo fffctl update'                   # the VM's portal release with `export` (the nightly copy needs it); this is the portal update
sudo fff-vm vault-sync                                 # records what has a file; copies the VM-only entries (Max's token) to vault-extra/
```

`add-claude` works after `install.sh --guest-only` alone (it uses commands every release has). Until the portal is updated,
`fff-vm vault-pull` says the VM cannot list its entries, the sync removes nothing, and the nightly alerts; nothing is
lost. No VM reboot; the next nightly runs the copy.

## 13. GitHub tokens per person (w868)

lothsahn (2026-10-10): "I would like you to enhance the portal vault to take GitHub fine grained access tokens as well. I'd
like the right token to get used based on whether a request is Ben or lothsahn. Let's setup the framework for that similar to
Claude tokens and I can get them installed for a switchover."

- **Code:** `server/githubTokens.ts` (the switch `githubFromVault`, the portal's runner `ghRunner`, the daemon's token
  `forMachine`, the probe and the health lines), `Vault.githubFor` / `Vault.githubTokens` and the `github` option of
  `Vault.forRun` (`server/vault.ts`), the GitHub part of `machineRunEnv` (`server/secrets.ts`), `githubToken` on the
  `switch` and `save_work` messages (`server/machineProtocol.ts`, `githubNetEnv` in `machine/daemon.ts`), the vault page
  (`GithubHealth` in `web/src/components/Vault.tsx`). Tests: `server/githubTokens.test.ts`, the GitHub cases in
  `server/vault.test.ts`.
- **The tokens are the ones sections 10 to 12 already carry:** `people/<person>/github-token` on the FFBox host, synced to
  the entry `vault-<person>-github` (`share: owner`, workers and standing agents on every machine). Nothing new to install
  on a machine, no second store.
- **Off until switched on.** One owner-only setting, `machines.githubFromVault`, the same shape as `claudeFromVault`: per
  machine, `"*"` for the rest, and the machine id **`portal`** for the portal's own reads. Before w868 a GitHub entry went
  to every run it was granted to whether or not anything was switched on; now it goes nowhere until this is on. *Measured
  before the change:* this worker (w868, a lothsahn request on m3) had no `GH_TOKEN`, and `gh auth status` showed m3's own
  login (`bryding`, a `gho_` OAuth token), so no lothsahn GitHub entry was being handed out on m3. A Ben entry, if one
  exists, would stop being handed out at the deploy and Ben's runs would use the machine's login again, which on m3 is Ben's
  account anyway (a guess for the other machines: the w511 map has BEAST's gh logged in as Ben too).

### 13.1 Which credential each GitHub caller uses

| Caller | Before (all measured or read in the code) | With `machines.githubFromVault` on |
|---|---|---|
| A worker's or standing agent's `gh` and `git push` | the machine's own gh login (on m3: `bryding`) | the request person's `vault-<person>-github` as `GH_TOKEN`, plus the credential helper (section 3) |
| The daemon's push in `switch_branch`, and its push of a released worker's saved work (w656) | the machine's own login | that worker's person's token, sent with the `switch` / `save_work` message (`githubToken`); an older daemon ignores the field and uses its login |
| The daemon's fetch for a new sandbox, the base refresh, a branch handover's push (`placeAgain`) | the machine's own login | unchanged: no request is behind them, and the handover pushes another worker's branch |
| The portal's blocker watch: `ci:` and `pr:` gates (`gh pr view`, the Actions runs) | the portal's own gh login (D7) | on `portal`: the person of the first request waiting on that PR (its requester, or the configured person for unnamed work, section 10) |
| The portal's ledger sweep, intake's merged-PR reads, a sandbox's PR look, FFBox's PR summary | D7 | on `portal`: the system payer's token (work no request is behind) |
| The orchestrator-memory push and the public-repo check (`server/memoryGit.ts`, `server/publicGit.ts`) | D7 | unchanged: D7 is the one with write on `ff-orchestrator-memory`, and the public-repo check reads the portal's own account |

### 13.2 The CI reads that failed since 2026-10-10 07:45Z, and the permissions each person's token needs

**What failed** *(measured: the ledger's unblock lines, e.g. w857 at 08:15, 08:32 and 08:49 UTC)*: "FF Factory could not read
CI on Final-Factory/FinalFactory#1371 for 15 min (its checks: GraphQL: Resource not accessible by personal access token
(repository.pullRequest.statusCheckRollup.nodes.0…", and the Actions-runs fallback "gh: Resource not accessible by personal
access token (HTTP 403)".

**Which token:** the portal's own gh login in the VM, D7 (`fffctl gh-login`, [portal-on-ffbox-host.md](portal-on-ffbox-host.md)),
a fine-grained token: every `ci:` read runs `server/blockerWatch.ts` `ghChecks` in the portal process with no `GH_TOKEN`
(code; the token's value is not visible to a worker, only its effect).

**What it lacks** *(sourced: GitHub, "Permissions required for fine-grained personal access tokens", read 2026-10-10)*:

- **Checks:** no fine-grained token can have it. The page has no "Checks" section at all, so the check-run nodes of
  `statusCheckRollup` are refused for every fine-grained token, D7's and the people's alike. This is permanent; `ghChecks`
  reads Actions runs instead (w829).
- **Actions: Read** on Final-Factory/FinalFactory: `GET /repos/{owner}/{repo}/actions/runs` is listed under "Actions"
  (read), and that call is the one answering 403. D7 was made with "read access to the repos the portal queries", which
  covers Pull requests and Metadata (its `gh pr view` of the state works) but evidently not Actions.
- *Why from about 07:45Z (a guess):* w846 (merged 04:33Z) made `ci:` gates the way every worker waits for CI; the portal
  deploy that carried it put many such gates on the watch from the morning on. The token itself was probably never able to
  read Actions runs.

**Fixing D7 now, without the switchover** (lothsahn, if he wants it before the person tokens): on github.com, the D7 token's
account → Settings → Developer settings → Fine-grained tokens → the portal's token → Edit → Repository permissions →
**Actions: Read-only** (and **Commit statuses: Read-only**) → Update. Editing keeps the same token value, so nothing in
the VM changes. If the organization requires approval for fine-grained tokens, an owner approves the change first.
Alternatively, the switchover below puts the portal's reads on the person tokens, which have Actions read.

**Until then (w889).** Ben, 2026-10-10: "Yes fix it", after every PR that day waited the 15-minute fallback. Two changes in
the portal, neither a token change:

- **A third reading, the merge state** (`mergeStateCi`, `server/blockerWatch.ts`). When checks and Actions runs are both
  refused, `ghChecks` reads the PR's REST `mergeable_state` (Pull requests: read, which D7 has). GitHub calls a PR
  `unstable` while a check is pending or failing and `clean` once all pass *(measured 2026-10-10 with a token that reads
  everything: #1393 with "Test in editmode" in progress, `unstable`; #1387 with every check done and green, `clean`)*. So
  `clean` after `unstable` on the same head commit is a green finish, and its wait clears at the next read (within about
  4 minutes). A PR seen `clean` without an `unstable` before it (checks not started yet) is not taken for green. Running and
  failed CI both read `unstable`, so a red CI still waits the 15 minutes. *Not measured:* that GitHub gives a token without
  Checks or Actions the same `mergeable_state`; the health check below shows what the live token gets.
- **A loud health check** (`server/ciReadHealth.ts`). At start (after a minute) and every 30 minutes the portal reads CI on
  the game repo's newest PR with the credential the watch uses for work no request is behind (D7, or the system payer's
  token with the `portal` switch on), and records the best it reads: `checks`, `actions`, `merge-state` or `none`. Below
  `actions`: a `WARNING: GitHub CI reads (w889)` line in `system_status` with GitHub's words and the fix, a dashboard banner
  for everyone ("FF Factory cannot read CI on pull requests."), and a `[host]` notice to the dispatcher plus the host
  notification, once when it turns bad and once when it recovers. Tested in `server/ciReadHealth.test.ts`.
- **The fix, in one line:** the portal's D7 token, on Final-Factory/FinalFactory: **Actions: Read-only** (Pull requests:
  Read-only and Metadata: Read-only, which it has); Commit statuses: Read-only is optional. Checks cannot be granted to a
  fine-grained token. Edit the token in place on github.com; its value stays, so nothing goes into the VM.

**One permission set per token.** A fine-grained token has one list of permissions for all the repositories it is given;
"repo by repo" is which repositories to select. **The requirements are lothsahn's** (2026-10-10, w904): "Give it these repo
permissions: Actions (RW), Artifact metadata (RO), Commit statuses (RW), Contents (RW), Discussions (RW), Issues (RW),
Metadata (Required), Pull requests (RW), Workflows (RW). And these organizational permissions: Self-hosted runners (RO). As
we find more permissions we need, please add them to the requirements". In code they are one list,
`shared/githubRequirements.ts`; `server/githubTokens.test.ts` fails when this table and that list disagree. The probe
(13.3) checks every token against them, and a dashboard banner asks for the token to be updated when one is missing
(13.6). **A worker that GitHub refuses (403, "Resource not accessible") for a permission or repository not listed here adds
it to `shared/githubRequirements.ts` and this table in a pull request, and says so in its report** (the evidence-gate lesson
"github-403-adds-a-requirement").

| Setting | Value | Why (sourced from GitHub's permissions page unless said) / how its read half is probed |
|---|---|---|
| Resource owner | **Final-Factory** | every required repository is the organization's |
| Repository access | **All repositories**, or select the list below | |
| Actions (repository) | **Read and write** | read runs, jobs and logs; re-run a failed job (`POST …/actions/runs/{id}/rerun`, write). Probe: `GET /repos/{repo}/actions/runs` |
| Artifact metadata (repository) | **Read-only** | artifact storage and deployment records. Probe: `GET /orgs/Final-Factory/artifacts/{digest}/metadata/storage-records` with a made-up digest: 404 counts as allowed, 403 as refused *(measured with a token that may read: 404)* |
| Commit statuses (repository) | **Read and write** | the status part of a PR's checks (`GET …/commits/{ref}/status`). Probe: that, on `HEAD` |
| Contents (repository) | **Read and write** | `git push`; merging a PR (`PUT …/pulls/{n}/merge` is listed under Contents, write). Probe: `GET /repos/{repo}/commits` |
| Discussions (repository) | **Read and write** | GitHub's REST has no Discussions endpoints (none on the permissions page). Probe: GraphQL `repository.discussions` |
| Issues (repository) | **Read and write** | PR conversation comments go through `…/issues/{n}/comments`; issues themselves. Probe: `GET /repos/{repo}/issues` |
| Metadata (repository) | **Read-only** | required by GitHub for any repository. Probe: `GET /repos/{repo}` (404: the repository is not selected) |
| Pull requests (repository) | **Read and write** | create, edit, comment on and read PRs (`POST …/pulls`). Probe: `GET /repos/{repo}/pulls` |
| Workflows (repository) | **Read and write** | pushing a commit that changes `.github/workflows/`. Write only: nothing to probe |
| Self-hosted runners (organization) | **Read-only** | the organization's runners (BEAST's and the ffbox runners). Probe: `GET /orgs/Final-Factory/actions/runners` |
| Checks | not offered | GitHub has no Checks permission for fine-grained tokens: `gh pr checks` cannot work with one |
| Expiration | the longest offered; write the date down | the vault page shows it from GitHub's `GitHub-Authentication-Token-Expiration` header; the banner warns 14 days before |

**Not checked:** the write half of every "Read and write" permission, and Workflows, which is write only. Reading them would
mean writing, so the probe does not try, and the banner says which ones it could not check.

The required repositories (config `vault.githubRepos`, default these nine, lothsahn's list) *(what FF Factory does in each:
measured from `gh repo list Final-Factory` and the repositories named in this repo's code and the worker briefs)*:

| Repository | What FF Factory does there | Needed |
|---|---|---|
| Final-Factory/FinalFactory (internal) | workers push branches, open and merge PRs into develop, read and re-run CI; the portal reads PR states and CI | required |
| Final-Factory/ff-factory (public) | workers' PRs to this portal, merged on green; the ledger sweep reads its PRs | required |
| Final-Factory/final-factory-agents (public) | skills and lessons (`publish-skills`) | required |
| Final-Factory/ffbox (private) | workers push fixes to ffbox master one at a time (w857's brief), read its code | required |
| Final-Factory/finalfactory-agent-kit (public) | the players' HowToPlay (`learnToPlay`) | required |
| Final-Factory/ff-marketing (private) | marketing skills' work | required |
| Final-Factory/ff-orchestrator-memory (private) | the orchestrators' memory (the portal's D7 push) | required |
| Final-Factory/KNN (internal) | the game's KNN package (lothsahn, w904) | required |
| Final-Factory/Facepunch.Steamworks (public) | the game's Steamworks fork (lothsahn, w904) | required |
| Final-Factory/ff-factory-private, multiplayer-community-contributions, nevergames-website | none found in this repo's code or briefs | no ("All repositories" covers them anyway) |
| bryding/FinalFactoryModTemplate, Lothsahn/* | the mod template (game repo `CLAUDE.md`, "Modding"); personal repositories | **cannot**: a fine-grained token has one resource owner. With `GH_TOKEN` set, gh and git use only it, so work on these fails with the person token. Until the template moves to the organization, such work needs a run without the switch (its machine `githubFromVault` off) |

### 13.3 Selection, fallback, expiry

- **Whose token:** the same person as the Claude token (section 10): a request's requester, the configured person for
  intake, FFBox and nightly work nobody named (`vault.unattributed`), else the system payer. A worker's run, the daemon's
  push for it and the portal's reads of its gates all name that person. Request-less portal reads use the system payer's.
- **Which entry:** the person's own GitHub entry, then one shared with anyone (`share: anyone`, by name); never another
  person's own (`share: owner`), as for every vault entry (`eligible`).
- **None usable** (no entry, disabled, refused, expired): the caller keeps the credential it had before (the machine's
  gh login, D7 for the portal), and `system_status` says so ("no usable vault GitHub token for a workers run on m3 for
  sam; it uses the machine's own gh login", 24 hours). Not held, unlike a Claude pool: a GitHub token has no capacity to
  wait for, and the fallback is what ran until now. *Decision (reasoned):* holding a person's work until a token is rotated
  would stop every push for a typo; the alert is enough while the machine logins stay.
- **401 (bad credentials, revoked, expired):** the portal's own call that got it is made again on D7 at once; the token is
  marked "not used" and no run, push or read gets it until it is rotated (a new fingerprint) or the next probe passes.
- **403 "Resource not accessible by personal access token":** a permission the token lacks. The portal's read is made
  again on D7 and the token's last error names the call; the token stays in use (other calls may be allowed). A refused
  `statusCheckRollup` is expected for every fine-grained token and is not recorded.
- **Expiry:** read from GitHub's `GitHub-Authentication-Token-Expiration` header at each probe *(sourced:
  composer/composer#11688 reads the same header for `composer diagnose`; not measured, no fine-grained token was available
  here)*. Past it, the token is not used; 14 days before, the line turns amber ("rotate it soon").
- **Probe** (w904): at start, whenever the vault changes (a new or rotated token, within 5 minutes), every 6 hours, and at
  once on **Re-check now**. It reads `GET /user` (the GitHub account and id, and the expiry header; it needs no permission),
  the organization's Self-hosted runners and Artifact metadata reads, and, per required repository (config
  `vault.githubRepos`), each probe of 13.2's table. That is about 75 requests per token per probe, against GitHub's 5,000
  an hour. Write halves are not probed (that would mean writing), and no API a token can call lists a fine-grained token's
  permissions, so each read is a real request and its answer is the measurement. A read that gets no answer (a network
  blip) is not counted against the token.
- **The portal's own gh login (D7) is probed the same way** (w904), through `gh api -i` and `gh api graphql` as the portal's
  user: gh reads its own credential, so the portal never handles the value. It is listed as "the portal's own gh login
  (D7)", with its own banner for the owners.

### 13.4 Attribution: what changes when a person's token pushes

- **Commit authorship does not change** *(sourced: git)*: the author and committer of a commit come from git's
  `user.name`/`user.email` (the machine's, or the public identity for public repositories); the token only authenticates the
  push.
- **PRs and comments do:** a PR a worker opens, a comment, a review or a merge is by the token's account. Today all of it is
  m3's or BEAST's login (measured on m3: `bryding`, for lothsahn's requests too); after the switch lothsahn's requests show
  as Lothsahn (GitHub id 10092359), Ben's as Ben.
- **Branch protection and required reviews:** nothing changes *(measured 2026-10-10, `gh api`)*. Final-Factory/FinalFactory
  `develop` has only the ruleset "Protect master and develop from rewrites" (no deletion, no force push, no bypass actors) and
  no required reviews or checks; `master` requires a PR with 0 approvals, linear history and resolved conversations;
  ff-factory `main` is unprotected and has no rulesets. No rule depends on who authored the PR.
- **FFBox reads comments by author, and lothsahn is its GitHub operator** *(sourced: Final-Factory/ffbox at 162c44c,
  `scripts/ffwatch.py` `is_github_operator`, `take_review_trigger`, `take_feedback`; `config.md` "operators")*. A pull request
  comment or review by GitHub id 10092359 is taken as lothsahn's own instruction: a `#codereview` / `!codereview` trigger starts
  a review, and any comment on a PR FFBox opened (`ffbox/` branches) or is already in starts a feedback run, billed to his
  subscription. With his token, a worker's comment on such a PR would do that. FFBox does not look at who authored a PR
  (searched `scripts/` for pull-request author reads: none). So a worker with a person's token is told in its brief to post
  no comment on FFBox's PRs unless the person asked for it. **This is the one real fork (13.7).**
- **Merging FFBox's PRs** (w860, w862) is unchanged: FFBox sees the merge and posts its notice itself, whoever merged.
- **`gh pr checks` stops working for workers on a person's token** (no Checks permission for fine-grained tokens): the brief
  tells them to read CI with `gh run list --commit <head sha>` and `gh run view`.

### 13.5 Machines

Nothing to install. The token reaches a worker in its launch spec (`spec.env.GH_TOKEN`), and the daemon's pushes in the
`switch` or `save_work` message, over the authenticated daemon link, as Claude tokens do (section 3): never on disk, never
in chat, redacted from transcripts and logs by pattern and by value (`addSecretValues`, the daemon learns a pushed one before
use). A daemon from before w868 ignores `githubToken` and pushes on its own login; its workers get the token anyway (the
spec is old). Keep each machine's own gh login: the fallback, and the daemon's own fetches (13.1).

### 13.6 The banner, the vault page and system_status

**The banner (w904).** lothsahn (2026-10-10): "Can you please build checks that if the necessary repos and permissions aren't
present, a banner appears at the top asking for the github token to be updated?" When a token lacks anything of 13.2, or is
refused (401), expired or within 14 days of its expiry, a banner "A GitHub token needs updating." is at the top of the
dashboard for **the token's own person and every owner** (the portal login's for the owners). It names the token
(`vault-<person>-github …abcd`, and its GitHub account), what it lacks ("Final-Factory/ff-marketing: not selected";
"Actions: read refused on FinalFactory"; "Self-hosted runners (organization Final-Factory): read refused"), the fix (edit the
token on github.com, Repository access and Permissions; its value stays, so nothing changes in the vault) and the
permissions it could not check (the write halves). Its **Re-check now** button probes every token and the portal login at
once (`POST /api/github/recheck`, anyone signed in, at most every 30 seconds); the banner clears by itself on the next
probe that finds nothing missing. Closing it hides it until its text changes.

**Also loud:** a `WARNING: GitHub token …` line per such token in `system_status`, and a `[host]` notice to the dispatcher
plus the host notification, once when a token turns bad (or what it lacks changes) and once when it has everything again.

**The vault page.** Each GitHub entry on Settings → Token vault has a line under it: the GitHub account it acts as, its
expiry with the days left, what it lacks, when it was probed, its last use ("given to a workers run on m3 for lothsahn",
"CI on Final-Factory/FinalFactory#1372") and its last error; amber when it lacks anything. Below the list: where GitHub
tokens from the vault are on, the portal login's line, and **Re-check now**. Last use and last error live in the portal's
memory (empty after a restart until the next use).

### 13.7 Switchover for lothsahn

Nothing switches until he does it, and each step is undone by the matching rollback line. Before step 4, the only change
anyone sees is the new line on the vault page.

1. **Decide the fork (FFBox comments, 13.4).** Recommended: switch as below; workers are told not to comment on FFBox PRs.
   The other choice is to keep lothsahn's requests on the machine login for comments, which this framework does not split
   (a token is all of gh). Ask if a guard (refuse `gh pr comment` on `ffbox/` PRs for his token) is wanted on top.
2. **Make each token** (each person, on github.com, signed in as themselves): Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → Generate new token, with the settings of 13.2. If the organization asks for
   approval, an owner approves it under Final-Factory → Settings → Personal access tokens → Pending requests.
3. **Install them on the FFBox host** (as root; the value is typed at a hidden prompt, never on a command line or in chat):

   ```bash
   sudo install -d -m 0700 /etc/fff-vm/secrets/people/lothsahn /etc/fff-vm/secrets/people/ben
   sudo bash -c 'umask 077; read -rs -p "lothsahn GitHub token: " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/lothsahn/github-token'; echo
   sudo bash -c 'umask 077; read -rs -p "Ben GitHub token: " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/ben/github-token'; echo
   sudo fff-vm vault-sync                     # "added vault-lothsahn-github", "added vault-ben-github"
   ```

   Ben types his own at the second prompt (a shared tmux session), or hands it over outside chat (Cut-over, step 2).
   This needs the portal deployed with w868 (`sudo fff-vm ssh 'sudo fffctl update'`): on an older portal the entries would
   go to every run at once (the pre-w868 behaviour).
4. **Check before switching:** Settings → Token vault, or `system_status`: each `vault-<person>-github` line shows the
   right GitHub account (lothsahn's has id 10092359), an expiry, and "reads ok on 7 repositories" (or names what is
   missing: fix it in the token's settings; a new or rotated token is probed within 5 minutes, a permission changed on the
   same token shows at its next probe, within 6 hours, or at once after a portal restart).
5. **Switch the portal's reads first:** `set_app_config machines.githubFromVault true machine: "portal"`. Check: the next
   `ci:` gate clears within about 4 minutes of its checks finishing, the log has no new `blocker watch: cannot read CI`,
   and the token's line shows "last used … (CI on …)".
6. **Switch one machine:** `set_app_config machines.githubFromVault true machine: "m3"`. Check with the next worker there
   for lothsahn: its brief has "GitHub: your gh and git push act as the token vault-lothsahn-github …abcd", `gh auth
   status` there shows Lothsahn, and its PR shows him as author. One for Ben's request shows Ben. Then m5, beast,
   lothdesktop, biscuit (or `true` without `machine` for all).
7. **Rotation later:** replace the host file, `sudo fff-vm vault-sync`; the new token is probed at once.

### 13.8 Rollback

`set_app_config machines.githubFromVault false machine: "<id>"` (or `"portal"`, or without `machine` for all): the next
process start, push or read uses the login it had before. Nothing else to undo: the tokens can stay in the vault, given to
nobody. To remove one for good: delete its host file, `sudo fff-vm vault-sync`, and revoke it on github.com.

## Decisions

1. **Sharing across people:** no. Each person's own tokens for their own work (lothsahn, 2026-10-06; section 10).
2. **Where the tokens and the key's spare copy live:** on the FFBox host under `/etc/fff-vm`, root only, not in the
   VM's daily backup (lothsahn, 2026-10-06; section 11).
3. **The workers' GitHub token:** one fine-grained token per person, scoped to the Final-Factory repositories
   (lothsahn, 2026-10-06), in place of w511's single workers' token.
4. **Entries made in the VM are copied to the host every night** (lothsahn, 2026-10-09, w749; section 12): root to root, a
   person's file is only created, the host file wins a conflict, the ops worker and the portal have no way to a value.
5. **The right person's GitHub token for each request** (lothsahn, 2026-10-10, w868: "I'd like the right token to get used
   based on whether a request is Ben or lothsahn"): workers, the daemon's pushes for them and the portal's reads, behind
   `machines.githubFromVault`, off until he switches (section 13).

## Cut-over

In order. Nothing here runs until lothsahn says so; each person puts in their own tokens, on the FFBox host, never
through chat. It assumes the portal runs in the VM (w508's cut-over) and this change is on `main`.

**1. The portal and the scripts** (lothsahn, on the FFBox host):

```bash
cd ~/ff-factory && git pull
sudo deploy/vm/host/install.sh --guest-only          # new fffctl, fff-portal.service, fff-backup; the VM's vault key; fff-vm vault-sync; and, since w744, the host's fff-vm and vault.sh
sudo fff-vm ssh 'sudo fffctl update'
sudo fff-vm ssh 'sudo fffctl status'                 # until the release is main's newest and /api/health answers
sudo fff-vm ssh 'sudo fffctl vault list'             # "key: loaded"
```

**2. Each person's tokens** (each person makes their own; lothsahn or Ben puts them on the host as root):

- **Claude:** on any computer signed in to your claude.ai account, run `claude setup-token` and copy the token it
  prints.
- **GitHub:** github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new
  token:
  - Resource owner: **Final-Factory**; Repository access: **All repositories** (or select the nine of section 13.2);
  - Permissions: the list in section 13.2 ([GitHub tokens per person](#13-github-tokens-per-person-w868)): repository
    permissions Actions, Commit statuses, Contents, Discussions, Issues, Pull requests and Workflows: Read and write;
    Artifact metadata: Read-only; Metadata: Read-only (required); organization permission Self-hosted runners: Read-only;
  - Expiration: up to a year; note the date. If the organization requires approval for fine-grained tokens, an owner
    approves it under the organization's Settings → Personal access tokens.
- **Put them on the host** (`<id>` is your portal user id: `lothsahn`, `ben`). `bash -c`, not `sh -c`: on the host `sh` is
  dash, whose `read` has no `-s` ("read: Illegal option -s"). Each command reads the token from the
  terminal without echoing it, so it is never on a command line, in shell history or in chat:

```bash
sudo install -d -m 0700 /etc/fff-vm/secrets/people/<id>
sudo bash -c 'umask 077; read -rs -p "Claude token: " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/<id>/claude-token'; echo
sudo bash -c 'umask 077; read -rs -p "GitHub token: " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/<id>/github-token'; echo
sudo fff-vm vault-sync                               # "added vault-<id>", "added vault-<id>-github"; values never shown
```

Ben is not on the FFBox host: lothsahn runs the same commands there, and Ben types his own tokens at the hidden prompts
(the two can share one ssh session to the host, for instance with `tmux`), or Ben hands the two values to lothsahn
through a channel that is not chat (in person, or a password manager's share).

**2a. More than one Claude token for a person (w739):** the same, one file per token, in the pool folder (each its own
`claude setup-token` from a different Claude account, or the same account's second login):

```bash
sudo install -d -m 0700 /etc/fff-vm/secrets/people/<id>/claude-tokens
sudo bash -c 'umask 077; read -rs -p "Claude token (second): " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/<id>/claude-tokens/second'; echo
sudo fff-vm vault-sync                               # "added vault-<id>-second"; values never shown
sudo fff-vm ssh 'sudo fffctl vault list'             # the pool section: both tokens, their state, meters and resets
```

From then on only the person's pool serves their runs (section 4). Someone with no token in the vault is unchanged
until they add one.

**3. Check:** `sudo fff-vm ssh 'sudo fffctl vault list'` shows `vault-lothsahn`, `vault-lothsahn-github`,
`vault-ben`, `vault-ben-github`, each with its last four characters; within a minute the usage meters show
"vault-<id> …abcd" accounts.

**3b. The names before w748 carry over (w748).** The sync used to name the entries `host-<user>-claude`,
`host-<user>-claude-<name>` and `host-<user>-github`; lothsahn asked for shorter names that are not cut off on the
dashboard. Nobody enters a token again: after the portal is updated, `sudo fff-vm vault-sync` sends each file to
`fffctl vault put` under its new name, and `put` finds the old entry holding the same token and **renames** it (`fffctl vault
rename OLD NEW` does the same by hand): its id, token, owner, grants, meters and the sessions' last pick stay, so no pool loses a
token in between and nothing running changes. The answer says `renamed: vault-ben-1 … (was host-ben-claude-1)`. A sync
against a portal that cannot rename yet (it is not updated) warns `host-ben-claude-1 stays: its new name vault-ben-1 is not in
the vault yet`, changes nothing, and the next sync after `fffctl update` renames. An old entry still there beside its new one (its
file holds another token now) is removed. The old names are never removed while their file exists.

**3a. The pool works** (after the deploy and a `vault-sync`): `sudo fff-vm ssh 'sudo fffctl vault list'` ends with a "Claude
token pools" section, one line per token: its last four characters, its state (`ok`, `held`, `one-at-a-time`, `retired`,
`exhausted`), its 5-hour and weekly percent with their resets, and how many agents ran on it at the portal's last save.
`system_status` has a "Claude token pool, <person>" line per person with the same, the agents running on each token, and
a verdict, plus a line per reserved credential ("the dispatcher's token file …dAAA: weekly 41%, reserve 25% (5 days to
reset)…"). A token whose line says "no numbers yet" has not been polled: wait for the next poll (2 to 15 minutes).

**3b. The orchestrators on their own pool** (lothsahn; owner-only): once a person's tokens are in, `set_app_config
claudeAccounts.orchestrator "vault"`. It applies to the next session start of each orchestrator (a running one keeps its
token until its process restarts, so restart them from the dashboard or wait for the next idle stop), and the ops worker
picks the pool of whichever person's orchestrator gave it the job, at the start of every job. `system_status`'s "Claude
account per agent" line then says "each person's own vault pool", and each pool line names the orchestrator's token.
Rollback: `set_app_config claudeAccounts.orchestrator "tokenfile"`.

**4. Max's Discord token, for the posting machine only** (in the VM; unchanged):
`sudo fffctl vault add --kind env --env FFDISCORD_APP_TOKEN --name max-discord --share anyone --machines lothdesktop --file /tmp/d && shred -u /tmp/d`.

**5. Switch one machine at a time** (lothsahn, in `set_app_config` or through his orchestrator):
`set_app_config machines.claudeFromVault true machine: "m3"`, then m5, lothdesktop and beast. A worker started there
for lothsahn's request says "vault token vault-lothsahn …abcd" in its brief, and `gh auth status` there shows his
token; one for Ben's request shows Ben's.

**6. After a few days with no fallback warning in `system_status`**, retire each machine's own logins (section 6, step
5).

**The installed `fff-vm` and the installer's sync are one function (w744).** `sudo fff-vm vault-sync` runs
`/usr/local/lib/fff-vm/vault.sh`; `install.sh --guest-only` runs `vault.sh` from the checkout for its own sync. Until w744
`--guest-only` left the installed copy alone, so a host whose installed copy predated the pool (w739) added
`people/<id>/claude-tokens/<name>` with the installer and then removed those entries with `fff-vm vault-sync`, which did
not know the folder and read every `host-…` entry as one whose file was gone. Now every mode of `install.sh` (`--guest-only`
included) copies `lib.sh`, `pathwatch.sh`, `vault.sh`, `fff-vm.conf.example` and `fff-vm` to `/usr/local/lib/fff-vm` and
`/usr/local/sbin` (`install_host_scripts`, `deploy/vm/host/lib.sh`), so after any `git pull` and install run the two agree. A sync
never removes an entry whose file exists (a file that is not a token now is warned about and its entry stays), and a scan that
finds no token file at all while `host-…` entries exist removes none: `sudo fff-vm vault-sync --prune` says that every
person's files really are gone. Run `install.sh` from the clone you pull in (`git -C <clone> pull`), not from another one.

**Rotating a token later:** replace its file (step 2), then `sudo fff-vm vault-sync`. **Removing a person's:** delete
their files, then `sudo fff-vm vault-sync`; revoke the tokens where they were made.

**Rollback, any time:** `set_app_config machines.claudeFromVault false machine: "<id>"` (the workers), `claudeAccounts.orchestrator
"tokenfile"` (the orchestrators and the ops worker). A machine to cut off
entirely: `sudo fff-vm ssh 'sudo fffctl machine-credential revoke <id>'`.

## Runbook

**Add, rotate or remove a person's tokens:** the files under `/etc/fff-vm/secrets/people/<id>/`, then
`sudo fff-vm vault-sync` (Cut-over, step 2). **Add one from the VM instead:** `sudo fff-vm ssh -t 'sudo fffctl vault add-claude <id>'`
(a hidden prompt); the nightly copies it to the host, or now: `sudo fff-vm vault-pull` (section 12). **Remove for good:** delete the
host file, then `sudo fff-vm vault-sync` (section 12.5).

**Any other secret** (in the VM): `sudo fffctl vault add … --file FILE`, or Settings → Token vault → Add a token
(owners only). The value is never shown again. `sudo fffctl vault rotate <name> --file FILE` replaces it; runs started
from then get it.

**Change who gets an entry:** `sudo fffctl vault grant <name> [--machines m3,m5|*] [--roles workers,standing]
[--owner ID] [--share owner|anyone] [--enable|--disable]`. A `host-…` entry's grants are reset by the next
`vault-sync`.

**Enroll a machine** (a new one, or after a revoke):
1. In the VM: `sudo fffctl machine-credential issue <id> --out /tmp/<id>.cred`. It is written to that file (0600) and
   never printed; a daemon still on the credential before it is dropped within 20 s.
2. Move the file to the machine and give it to the worker installer (w513, [worker-install.md](worker-install.md)):
   `-CredentialFile` on Windows, `--credential-file` on a Mac. It goes into the root's `secrets/machine-token`. Delete
   the file in the VM and on the machine. (A machine still deployed by `add_machine` gets its own credential that way.)
3. The machine's daemon connects; `list_machines` shows it online.

**Cut a machine off:** `sudo fffctl machine-credential revoke <id>` (or ✕ beside it in the dialog). Its link drops
within 20 s; its sandboxes and sessions stay for when it is enrolled again.
