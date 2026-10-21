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
- **Every Claude process runs on a vault token (w1078).** There is no host token, token file, stored login or machine
  login to fall back to: lothsahn, 2026-10-12, "Delete claudeTokenFile and its associated config. Also delete claudeEnv, get
  rid of the fallback mode, everything runs off the vault". The other secrets are given only where an entry is granted.
  How the cut-over went (before w1078 it was a switch per machine): [Cut-over](#cut-over).

## 1. Inventory: every secret a worker or its daemon uses

Paths and code come from w511's map (`docs/worker-root.md`, ff-factory #135, measured on BEAST) and from this repo.
**Moves** means it goes into the vault. **Stays** means it stays where it is, with the reason.

| Secret | Who uses it | Where today | Decision |
|---|---|---|---|
| Claude subscription OAuth tokens (`sk-ant-oat01-…`, `claude setup-token`) | every worker and standing run | before w1078: config `claudeEnv.CLAUDE_CODE_OAUTH_TOKEN` (the host token), `userClaudeEnv` (people's own), a machine's own `/login` (`~/.claude/.credentials.json` or the Keychain), BEAST's `~/.claude-worker-token`; all retired | **Moved**: kind `claude`, one chosen per run ([section 4](#4-which-claude-token-a-run-gets)) |
| The workers' GitHub token (push, PRs, `gh`) | every worker | gh's login in each machine's keyring (BEAST: Windows Credential Manager, git's helper `gh auth git-credential`; measured in w511) | **Moves**: kind `github`, given as `GH_TOKEN`, plus a git credential helper that reads it (`githubCredentialEnv`). One fine-grained token per person (lothsahn, 2026-10-06; section 10), used where `machines.githubFromVault` is on ([section 13](#13-github-tokens-per-person-w868)) |
| Max's Discord bot token (the ffdiscord CLI's reads and writes) | runs that use the `ffdiscord` CLI directly (LothDesktop's today); posting as Max no longer needs it: `post_as_max` has FFBox post (w901) | `~/.config/ffbox/secrets.env` and `config.json` on LothDesktop | **Moves**: kind `env`, `FFDISCORD_APP_TOKEN`, granted to the posting machine only. *Measured:* `ffdiscord.py:9,236-238` (ff-discord plugin) reads `FFDISCORD_APP_TOKEN` from the environment before any file. `FFDISCORD_SERVER_ID` is not a secret and stays in the machine's config |
| Any other API key a run needs later | as granted | — | kind `env`, any variable ending `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD` |
| The machine token (`ffm_<id>_…`) | the daemon, to reach the portal | `daemon.json` (w511 moves it to `secrets/machine-token`) | **Stays**: it is the enrollment credential, the one thing a machine must hold to be given anything |
| The outside watch's ntfy topic | the M5's daemon | `outside-watch.json` in the daemon's folder | **Stays**: it must raise the alarm while the portal is down, so it cannot depend on the portal. The portal already sends it (`outside_watch`); the machine keeps the copy |
| ssh keys (`~/.ssh`: peer runs, the portal's deploy key) | lab and audit scripts, `add_machine` | each machine's `~/.ssh`; the VM's `/srv/fff/home/.ssh` | **Stays**: a key is tied to the peers' `authorized_keys`; the deploy key is the portal's own |
| Unity's licence activation | the editors | each machine | **Stays**: Unity binds it to the machine |
| The self-hosted GitHub runner's registration (BEAST, `finalfactory-mode2-windows`) | the game repo's CI | `C:\Users\rydin\actions-runner-finalfactory-mode2\` | **Stays**: GitHub's runner, outside FF Factory |
| steamcmd's login cache (M5, `~/.steamcmd-home`) | last-resort manual uploads (`mp-beta-deploy`) | the M5 | **Stays**: a person's own login, used by a person (w511 5.1); releases go through ffbox CI |
| The Steam build account `Lothsahn_FFBox`'s password (w1639), and its Steam Guard authenticator's `shared_secret` if it ever has one | the urgent release lane on BEAST, else LothDesktop: FFBox's `ffsteam.py` logs the account in by itself from the password when steamcmd's cached token is gone, making a Guard code (TOTP) from the secret only when there is one (ffbox 971cd6f, 74083e4) | nowhere before: a person typed the password at each computer's steamcmd once | **New**: an entry of kind `env`, `FFSTEAM_PASSWORD`, roles `workers`, machines `beast, lothdesktop`, shared with any run (an urgent release may be Ben's or lothsahn's); `FFSTEAM_GUARD_SECRET` the same way only if the account gets an authenticator (lothsahn: "Let's assume no authenticator for now"). Both names end `_PASSWORD`/`_SECRET`, so the daemon redacts their values (`SECRET_ENV`). FFBox keeps its own copy in its `secrets.env` ("nothing shared with FFBox"). Design: the game repo's `Documentation/Release-Lanes.md`, "Steam credentials" |
| FFBox's config and secrets (`~/.config/ffbox`, its connector token) | FFBox | FFBox's host, LothDesktop | **Stays, never shared**: the "nothing shared with FFBox" rule (D8) |
| `AgentControl/session-*.json` bearer tokens | the game's agent automation | the game's data folder | **Stays**: the game makes one per session, for local use only |
| The portal's own: its GitHub token (D7; since w868 its reads for a request use that request's person's vault token where `machines.githubFromVault` has `portal` on, section 13), its Discord token copy, web-push keys, API keys | the portal | `/srv/fff/secrets`, `/srv/fff/home`, `data/` | **Stay as they are**: no worker uses them. (Lothsahn's subscription token for the orchestrators, D4, was `/srv/fff/secrets/claude-oauth-token`; w1078 moved every orchestrator onto vault tokens and the portal deletes that file, [section 4](#4-which-claude-token-a-run-gets).) |

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
- **No key, or the wrong one:** the vault still lists, but hands out nothing it cannot open. A Claude process then does not
  start, and says why (section 4; before w1078 it fell back to the host token or a login), and `system_status` names the
  entries sealed with another key. Rotating an entry re-seals it with the current key.
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
| `github-app` (w1519) | a GitHub App's private key (the `.pem` file), with its App ID and the accounts whose installations are used; added on the vault page with the `.pem` file chosen in the browser (or `--app-id`, `--app-owners`) | never to a run: the portal mints the app's installation tokens and a run's git and gh use them for the repositories it is installed on ([github-apps.md](github-apps.md)); the name may not start `vault-` or `host-` |

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

**The order (w971, w1659).** The token with the highest **score** first. The score is its weekly headroom per hour until its
weekly window resets: `(100 - weekly %) / hours to the weekly reset`, the hours less a soft offset of about 24 ("Near a weekly
reset" below), scaled by the room left in its 5-hour window, `(100 - 5-hour %) / 100`. The score only orders the pool; it is not shown anywhere (w979, below). lothsahn, 2026-10-11:
"let's prefer the token weighted by the reset, but not solely based on the reset. Basically like use the token with the largest
remaining %/time left or something like that." Reading it as headroom per hour: a token with 3% left and 3 days to go scores
1%/day, one with 73% left and 4 days scores 18%/day, so the second is picked; the old "soonest reset first" would have tried the
nearly used-up one first (vault-ben-2 at 97% on 2026-10-11 04:32Z). Details *(guesses, no data behind them yet)*:
- The hours to the reset are never counted below one (`MIN_HOURS_TO_RESET`), so a token minutes from its reset does not score as
  infinite; a token about to reset with room left still scores high, which is right: that room is lost if unused.
- The 5-hour room is a multiplier, so a token at 70% of its 5-hour window scores 0.3 of what a fresh one would. The caps stay
  as they were (80% 5-hour: held; 95% weekly: one at a time; 99%: retired; 100: used up) and apply before the score.
- **Ties** (scores equal to 9 digits): the soonest weekly reset, then the 5-hour reset, then the fewer live runs, then the name.
- A token with no weekly reset time (no numbers yet) has no score and goes after every scored token.
- The same order applies to workers, standing agents, a person's orchestrator and the ops worker; a session still keeps its token
  while it passes (sticky), but not one inside the dispatcher's reserve (below).
- **A resume picks its account by the same rule as a new job (w1375).** Ben, 2026-10-15: "Resuming a worker whose vault account is
  retired must move it to the person's usable account, not loop". On 2026-10-15 vault-ben-3 was retired (weekly 100%, until
  Mon 05:00Z) and workers 19939b45 (w1335), 14fac04c (w1360), 012acc44 (w1329) and a735f37c (w1332) stalled on it again at
  once after being resumed. Every resume (a limit or restart resume, the ledger cleanup's revival, a CI or blocker unblock, a
  dispatcher follow-up, `message_agent`, a `wake_me` check-in) is one `SessionManager.send`, which does one of two things:
  - **no live process:** the message starts a new one, and `machineRunEnv` → `Vault.forRun` → `pickPool` picks the account.
    The saved pick is only the sticky one, kept while it still passes (`ok`, or `one-at-a-time` with its slot free), so a
    retired or used-up account is skipped for the person's usable one (for Ben, vault-ben-2). Nothing usable: `PoolHeldError`,
    the message waits in the send queue (`on: 'pool'`, Blocked, up to 8 days) and goes when a token frees, as a new job's first
    prompt does. It never starts on the retired account, so it cannot hit its limit again and loop;
  - **a live idle process** keeps the token it started on, and that was the leak: the 13:15Z resumes of w1335 went to a process
    still on vault-ben-3 ("already on it"). `Agents.accountMove` now also returns a reason when its token (`SessionInfo.account`)
    is `retired` or `exhausted` (`agents.tokenUnusable`, wired in `server/index.ts` from `vault.pools`), so `moveFor` stops
    the idle process and the message starts the next one as above. Not mid-turn (the message reaches the running turn, which
    moves at its next message) and not with a background task running. A `held` (5-hour 80%) or `one-at-a-time` token still
    works, so a live process on one is left alone.
  The ledger cleanup decides whether to resume a worker a limit cut off from its person's pool too (`limitsClearFor` →
  `poolForRef`: some token of the pool is one a new worker would get), not from the meters of the one account that hit it. Without
  a pool for that person it reads that account's meters as before.
**Near a weekly reset (w1539, w1659).** lothsahn, 2026-10-21: "Instead of having it go first like that, can we just adjust the
weighting so it gets used sooner? Like subtract 12 or 18 hours from the time remaining so that it starts getting consumed
first?", then "Let's make the new setting 24 hours, not 12", with his earlier limit (2026-10-19): "We don't want it to always use the token about to expire first, though, as we
want to be able to handle a sudden 5 hour burst of activity--and if all the tokens are used up except one, we'll only have 1 5
hour session to pull from." Two rules (`server/tokenPool.ts`):
- **The soft offset (the order, `effectiveHours`, `pickOrder`).** The score divides by the hours to the reset less
  `vault.pool.resetOffsetHours` (24), softly: `h - 24 x (1 - e^(-h/24))`, never below 1 h. Days from the reset that is the hours
  less 24; near it the weight grows smoothly (26 h counts as 10.1, 12 h as 2.6, 3 h as 1), so no token jumps the queue at an
  hour mark, and a token with little room left near its reset still waits behind one with much more. On 2026-10-21 ~06:00Z the
  score alone ranked vault-ben-3 (58% left, 119 h) over vault-ben-2 (12%, 26 h) and vault-ben-1 (22%, 45 h), 0.47 / 0.46 / 0.45
  %/h; with the offset the order is ben-2 (1.19), ben-1 (0.82), ben-3 (0.59). 0 turns it off.
- **The caps lifted (`judgePool`).** Inside the last `vault.pool.nearResetHours` (12) before a token's weekly reset its
  **one-at-a-time (95%) and retire (99%) caps are lifted**: room left at the reset is lost, so it may take parallel work up to
  100%. Only while at least `vault.pool.nearResetFloorTokens` (1) **other** token of the pool can take a new process on its own
  reading, so a burst always has more than one 5-hour window; a pool of one token never lifts its caps. The 5-hour hold, the
  dispatcher's reserve and stop line, and 100% still apply. Nothing "goes first": the order is the score's.
- The orchestrator's and the ops worker's rules are unchanged: they read the same states and the same order.

*What it rests on* (w1659, `scripts/pool-replay.py` on the journal's `usage:` lines from 2026-10-06 to 2026-10-21 06:00Z, 4,171
readings; the portal keeps no other meter history). Measured: the room left at the pooled tokens' weekly resets was 0-3% (ben-1
1%, ben-2 0%, ben-3 0%, lothsahn-1 2% and 3%). Replayed (an estimate; Ben's three tokens 2026-10-12..21, 30 shuffled quiet and busy
weeks of the measured days, at 0.7 / 0.85 / 1.0 of the measured demand; a 5-hour point is 6.5 weekly points, fitted):

| Scheme | room lost per reset | room left 24 h before a reset | hours with <= 1 token ready | worst-case burst share |
|---|---|---|---|---|
| the score alone (w971) | 20.61 / 8.71 / 2.65 | 40.1 / 23.5 / 10.2 | 3.5 / 64 / 283 | 0.56 / 0.28 / 0.08 |
| w1539: 12 h "goes first" + caps lifted | 20.57 / 8.45 / 2.19 | 41.0 / 24.6 / 11.0 | 1.2 / 51 / 252 | 0.58 / 0.29 / 0.09 |
| subtract 12 h (floor 1 h), caps lifted | 20.36 / 8.29 / 2.11 | 40.4 / 23.0 / 9.8 | 2.5 / 54 / 267 | 0.51 / 0.23 / 0.06 |
| subtract 18 h (floor 1 h), caps lifted | 20.29 / 8.24 / 2.09 | 39.6 / 21.7 / 8.8 | 2.8 / 54 / 267 | 0.44 / 0.19 / 0.05 |
| soft 12 h, caps lifted | 20.40 / 8.28 / 2.11 | 40.3 / 23.1 / 9.9 | 2.2 / 53 / 261 | 0.52 / 0.25 / 0.07 |
| soft 18 h, caps lifted | 20.33 / 8.26 / 2.11 | 40.0 / 22.5 / 9.4 | 2.5 / 54 / 264 | 0.49 / 0.23 / 0.05 |
| **soft 24 h, caps lifted (the default, lothsahn's pick)** | **20.31 / 8.25 / 2.09** | **39.7 / 22.0 / 9.0** | **2.5 / 54 / 266** | **0.47 / 0.21 / 0.05** |
| soft 12 h, caps not lifted | 20.40 / 8.49 / 2.49 | 40.1 / 22.6 / 9.4 | 4.0 / 64 / 284 | 0.49 / 0.24 / 0.06 |

- The soft 24 h offset uses the room before a reset sooner than w1539 (1.3-2.6 points less left a day out) and loses a little
  less at the resets (0.10-0.26 points); it costs some burst readiness against w1539 (1-14 more hours with one token ready in
  about five weeks, a worst-case share 0.04-0.11 lower). Soft 12 h sits between them (0.7-1.5 points sooner, 1-9 more hours,
  0.02-0.06 lower). Against the score alone the 24 h offset has fewer hours with one token ready, with a worst-case share
  0.03-0.09 lower. The hard offsets (lothsahn's "subtract 12 or 18 hours" with a 1 h floor) put every token inside the last
  13 or 19 h at the front, the switch he asked to drop, and lost more worst-case burst for no less room lost.
- **The caps lifted still help**: without them the offsets left 11-23 more hours with one token ready at 0.85 and 1.0 of the
  demand, and lost up to 0.4 points more per reset. A 24 h lift window brought the hours with one token ready under w1539's in
  the replay (46 / 249), but the replay does not model processes cut off at 100% mid-run, so it stays 12 h.
- **A burst guard on the weight** (no offset while no other token had 12, 20 or 30% of weekly room) did not help: within an
  hour of the same hours with one token ready, and a lower worst-case share, since dropping the weight sends that work to the
  other tokens just when they are low. The floor stays on the caps.
- The replay assumes every token is the same plan and one process burns at most 2% weekly an hour; the ranking held at 1 and 4.

The meters are the ones `UsageTracker` polls (section 4a).

**The limits** (one system-wide set, config `vault.pool.*`, percent 0 to 100 unless the table says otherwise, defaults below; **anyone** may change them
with `set_app_config`, not only an owner; the one-at-a-time limit may not be above the retire limit; each change is
logged in the portal journal with who made it; they apply at the next process start, no restart):

| Key | Default | A token at or past it |
|---|---|---|
| `vault.pool.sessionHoldPercent` | 80 | its **5-hour** meter: no new process on it until that window resets |
| `vault.pool.onePerWeeklyPercent` | 95 | its **weekly** meter: **one** live process at a time |
| `vault.pool.retireWeeklyPercent` | 99 | its weekly meter: **retired**, handed to nobody until the weekly window resets |
| `vault.pool.nearResetHours` | 12 | (hours, 0 to 168; 0 turns it off) inside these last hours before its **weekly reset**: its one-at-a-time and retire caps are lifted ("Near a weekly reset" above, w1539) |
| `vault.pool.nearResetFloorTokens` | 1 | (whole tokens, 0 to 10) the near-reset rule applies only while at least this many **other** tokens of the pool can take a new process |
| `vault.pool.resetOffsetHours` | 24 | (hours, 0 to 168; 0 turns it off) not a cap: the pick order takes about this many hours, softly, off each token's time to its **weekly reset**, so room that a reset would lose is used sooner ("Near a weekly reset" above, w1659) |
| `vault.pool.dispatcherStopPercent` | 95 | the **dispatcher's pinned token** only, either meter: its workers are asked to save and stop, and no new worker starts on it until that window resets ("The stop line" below, w1109) |
| (at 100) | | either meter: **used up**, handed to nobody until it resets (a rejection by the API counts as 100) |

A token with no numbers yet counts as 50% on both meters, so it passes every rule and ranks last (no weekly reset time, so no score). "Live" counts the
sessions whose process started on the token, not the asking session itself, and a pick made in the last 20 seconds before
its process shows (two starts cannot both take the last slot).

**Sticky per session.** A session keeps its token only while the token still passes these checks; otherwise it moves to
the next. The choice is made at each process start, never mid-process.

**When the pool has no token that may serve the run** (every one held, one-at-a-time with a process running, retired or
used up):

| Role | What happens |
|---|---|
| A worker, a standing agent | **Held** with the reason ("lothsahn's Claude token pool is held: every token is at a limit (a: 5-hour 90% (>= 80): held until Fri 14:00Z; b: …): the first frees up Fri 14:00Z"): a worker's first prompt queues and is tried again, a standing agent's run ends "Could not start: <reason>" and the next scheduled run tries again; no fallback to another credential (none exists since w1078) or anyone else's pool |
| The **ops worker** (w1112) | **Never held by the caps** (lothsahn, 2026-10-12: "The ops worker should not hold based on tokens, just like the dispatcher"): like the orchestrator below, it runs on the person's token with the most room while any is only past its caps, one at a time not binding it, but it takes the dispatcher's reserved token **last**, after every other token not used up. Once every token is used up (100%: Claude refuses them) it does not start: "<person>'s Claude token pool is used up, so the orchestration worker cannot start until a token resets (...)" with the reset (`poolRunEnv`). Its job is short and rare (a deploy, a restart, a machine update) and a person asked for it in their own words, so a cap that keeps workers from eating the person's own use has nothing to keep here |
| A person's own **orchestrator** | **Uses the pool up**: while some token is only past its caps (held, one-at-a-time, retired) but not used up, it runs on the one with the most room (the soonest reset on a tie), and the one-at-a-time rule does not bind it. A token inside the dispatcher's reserve (next section) is used before any of those, and only when no other token passes its caps. Once every token is used up it **stops** with the reason and the next reset on the dashboard; there is no override and no fallback |
| A token **inside the dispatcher's reserve**, when no other token of the person has room (w971) | A worker or a standing agent is **held** like at any limit (the reason names the buffer and when it lifts); the person's orchestrator runs on it, as it did before; the ops worker runs on the person's other tokens past their caps first and on it only when it is the last one not used up (w1112) |
| The **dispatcher** | The token `claudeAccounts.dispatcher` pins (w996, "The dispatcher on a vault token" below) and is never held; unpinned, the system payer's pool like an orchestrator (w1078). A pinned token the vault cannot give stops it with the reason |

**What a token at the one-at-a-time limit is (w747, relabelled w979).** A token at 95% weekly is not over its cap: it still
works, one process at a time, until 99%. Under each pooled token the portal's accounts list, `system_status` ("Claude token
pool, <person>") and `fffctl vault list` show one label and the token's own meters, nothing calculated (lothsahn, 2026-10-11:
"just say pool:ok (if it's not in one-at a time mode), pool:one-at-a-time (if it is in one at a time mode, even if nothing is
using it), and the pool slot that is currently the one that will get picked for each pool should be marked "priority" on the same
line ... Remove all the other calculations entirely"):
- `pool:ok`: below the one-at-a-time limit (95%), or inside the last 12 h before its weekly reset with its caps lifted (w1539).
- `pool:one-at-a-time`: from the one-at-a-time limit up to the retire limit, **whether its one slot is free or taken** (before
  w979 a free slot read `ok`). A new job still starts on it when the slot is free, and waits when it is taken; the queue's "held"
  reason says which ("... one job at a time; its slot is taken (1 running)").
- `pool:held`, `pool:retired`, `pool:exhausted`, `pool:reserved`: the rarer states, in the same form, with their reason
  after it as before (held until, retired until, used up until, the dispatcher's buffer).
- ` priority` after the label on the one token per pool that the picker would hand a new worker now (`pickPool` without a sticky
  session: the best score among the tokens a worker may use). At most one per pool; none when nothing may serve a worker.
  Example: `vault-ben-1 …nQAA pool:ok priority`.
- Kept: the 5-hour and weekly percent with their resets, the agents running on it. Gone: the %/day score, the 5-hour-room factor,
  "N% weekly left over N days", "N% left before it stops", and the slot-free/taken sentence on the line.
Tokens are listed in the picker's order. "At a limit" and "wait until the reset" are said only when every token is held or
retired; "used up" only when every token is at 100% or rejected.

**The banner at the top of the dashboard (w747).** A pool warning is shown only to the person whose pool it is (the server
sends each connected page only its own: `warningsForUser`, `hostForUser`); the owners still see every pool in
`system_status` and on the accounts page. It appears only when **no** token of that person can take new work: every one held
or retired ("Every one of your Claude tokens is at a limit (...). New work waits until the first one frees up (Fri 14:00Z).")
or every one used up ("All your Claude tokens are used up (...) ... and the orchestrator is stopped; there is no override.").
A token that is merely busy with its one job (`slot-taken`) shows no banner: the next job starts when the running one
finishes, which the queue's "held" reason says. The banner about the dispatcher's reserve (`reserve:…`) is for **the
person whose pool holds the dispatcher's token** (its vault entry's owner), and for each owner when the entry has none; never
for everyone (w1108, lothsahn: "Please only show the dispatcher message to the operator whose pool that token is in.";
`reserveWarnings`, `server/secrets.ts`). Its text and the system_status line are unchanged.

**No token, no run (w1078).** A person with **no** Claude token in the vault, or none that the key opens, has no account to
run on, and nothing stands in for it: the host token, the token file, the stored login, a machine's login and a per-person
`userClaudeEnv` token are all gone (lothsahn, 2026-10-12: "get rid of the fallback mode, everything runs off the vault").
The session does not start and says why in the start error and in `system_status`'s vault warnings: "<person> has no Claude
token in the vault, so <the run> cannot start: add one with `sudo fffctl vault add-claude <person>`" (`noTokenWhy`,
`server/secrets.ts`), or "<person>'s Claude token pool cannot serve <the run>: <the entry problems>" when they have tokens
and none opens. A pool that is only held or used up waits as above. Work nobody asked for runs on the pool of
`vault.unattributed`'s person (section 10); with none named it does not start.

**The dispatcher's reserve (enforced since w971).** The vault token the dispatcher is pinned to (`claudeAccounts.dispatcher`
"vault:<entry name>", resolved from config at each look) keeps a buffer for it (before w1078 the token file, the host token and
the host login had one too; they are gone). Unpinned, the dispatcher runs on the system payer's pool and has no reserve:
that pool's own limits hold it like anyone's. The buffer is: **5% of the weekly window for each day left until that window resets** (35% with seven days to go, 5%
with one, 0 at the reset; `vault.pool.reservePerDayPercent`) and **20% of the 5-hour window**
(`vault.pool.reserveSessionPercent`). The reserve is the dispatcher's: it may always run into it, up to 100%, and
nothing checks it before the dispatcher starts.

Until w971 nothing was refused by it, and vault-ben-2 (the token file's token, also in Ben's pool) sat at 97% weekly with
both orchestrators, the ops worker and two workers on it, while vault-ben-1 had 73% left. Now **the dispatcher's pinned vault
token** (matched by the token's fingerprint, `reservedCredentials` in
`server/secrets.ts` against the entry's `fingerprint`; `reservedFor` in `server/index.ts`), **while either meter is inside
its buffer, is handed to no new run while another token of that person's pool has room** (state `reserved`: no worker, no
standing agent, no ops worker, no orchestrator). "Has room" means passes every cap in section 4 (not held, not at its one slot,
not retired, not used up). When none does:
- a person's own **orchestrator** takes the reserved token as before (it uses the pool up; docs above), so nothing new
  locks it out;
- the **ops worker** (w1112) runs on the person's other tokens past their caps first, and on the reserved token only when every other one is used up: it may eat into the buffer, like the dispatcher, but last. *Why last and not never* (a judgment): a pool of one token, lothsahn's on 2026-10-12, is the dispatcher's own token, and "never" would hold the deploy lothsahn asked for whenever that token is inside its buffer, which is what w1112 removes; a deploy or a machine update is a few dollars of use, against the hours a worker can run;
- a **worker and a standing agent wait** (held), like at any other limit. *Why workers wait* (a judgment, with
  the sources I have): the reserve exists so the dispatcher, which starts every worker, never runs dry (the section above and
  w739); a worker that eats the last of it can stop the dispatcher for everyone, while a waiting worker costs a delay. The
  same reasoning already holds workers at 95% and 99% so the person's own orchestrator keeps the pool's last part (this
  section, "when the pool has no token that may serve the run"). The wait is bounded and visible: the held reason and
  `system_status` name when the buffer lifts, which is when the week's buffer (5% a day) has shrunk below what is left, at
  the latest at the weekly reset, or the 5-hour reset for the 5-hour buffer. Not measured on live traffic.
- A token with no reading yet counts as inside its reserve (`noReading`), so it is the last choice until its first reading.

Running processes are never touched. The pick is made at each process start, resumes included, so a worker or orchestrator already
on the reserved token moves to another token at its next start or resume. `system_status` shows each reserve ("the
dispatcher's vault token vault-ben-2 …dAAA: weekly 41%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%") and, while a meter is inside
the buffer with other runs on the credential, the dashboard shows a warning. Both the status line and the warning name only
the limit or limits that put the token inside the buffer, each with its figure, its buffer and its reset ("5-hour 93%
(buffer 20%), resets in 10 min"; both, when both are inside; `reserveReason` in `server/tokenPool.ts`): the week is never given
as the reason while it is outside its buffer (w828). One token is one account: two tokens of one Claude account are not matched,
so such a token would have its own meters and its own reserve.

**The stop line (w1109).** lothsahn, 2026-10-12: "at 95%+ session or weekly usage the dispatcher asks all workers using the
dispatcher key to stop, save their work and push". When either meter of the dispatcher's pinned token reaches
`vault.pool.dispatcherStopPercent` (95; anyone may change it with `set_app_config`, like the other limits), the portal
(`DispatcherStop`, `server/dispatcherStop.ts`, every 30 seconds from `server/index.ts`) does this, each point *read* from the code
and covered by `server/dispatcherStop.test.ts`:
- **Who is asked.** Every worker (`kind` worker) whose process runs on that token (`SessionInfo.account`) and is mid-turn
  (running, starting, or waiting for a permission). Not the dispatcher, not the orchestrators (they use the pool up, above), not
  the ops worker (the harness takes no message to it but its own orchestrators', w597, and w1112 runs it past the caps), not
  standing agents (one short scheduled run each), not other tokens' workers. An idle worker is not asked: it has nothing running,
  and its next message restarts its process on another token first (below).
- **Once per crossing.** A crossing starts when a meter reaches the line and ends when both are below it again (the window's reset)
  or the dispatcher is pinned to another token. Each worker is asked once in it, however many readings follow; a worker that
  starts a turn on the token later in the same crossing (one with a background task keeps its process) is asked once too. The
  crossing and who was asked are kept in `data/dispatcher-stop.json`, so a portal restart does not ask them again.
- **The message** (`[token stop] ...`, `stopMessage`) goes the normal way (`SessionManager.send`, from the harness), so a worker
  mid-turn reads it at its next step: do not start anything long; commit the work in progress on its own branch and push it, and if
  the push is refused (a guard, a hook, a protected branch) keep the commit local and say so, never discard or stash; end the turn
  with a report and a `wNNN: still open: stopped at the dispatcher token's stop line; resumes on a token with room` line; set no
  wake_me.
- **Interrupted after 15 minutes** (`INTERRUPT_AFTER_MS`) if it is still mid-turn. *Why 15* (a judgment, not measured): a worker
  reads a message sent mid-turn only after the tool call it is in, and a foreground shell command may run 10 minutes (Claude
  Code's Bash timeout, 600000 ms at most); committing, the repos' prepush checks, pushing and the report take a few minutes more;
  the restart drain gives the same wrap-up 10 minutes (`drainMinutes`, `server/restart.ts`). An interrupt loses nothing: the work
  stays in the worker's sandbox, committed or not, and the sandbox stays its own. At 95% the token has 5% left, so the wait costs
  at most a few points of the dispatcher's margin.
- **Then its requests are Blocked** on that token's limit (`Orchestrators.tokenStopBlocked`): a `usage` gate naming the token
  ("vault-lothsahn-1 …EAAA's usage limit"), set as the worker's own, once its turn has ended (asked and finished, or
  interrupted). Blocked, not Queued: a usage limit is a thing, not capacity (docs/orchestrators.md, "Waiting, Queued, Blocked";
  w1089 keeps Queued for a free place only). The gate clears when the token's owner's pool can serve a worker again
  (`ownerPoolServes` in `server/index.ts`: some token of that pool is the one `pickPool` would hand a new worker), which is at
  once when another of the person's tokens has room, else at the reset that frees one. The blocker watch then resumes that worker
  (`resumeGatedWorker`), and since its idle process still runs on the stopped token, `Agents.accountMove` stops it first and the
  message starts a new process in the same conversation on a token with room. A usage gate naming any vault token clears this
  way (the pool's answer); a usage gate naming another account (an email) still clears when its meters are under 90%.
- **No new job on the token from the same reading.** A meter at the stop line counts as **inside the dispatcher's reserve**
  (`reserveOf`: `stopWeekly`, `stopSession`), so the token is `pool:reserved`: no worker or standing agent is handed it (they
  move to another token of the person's, or are held when none has room), and the person's own orchestrator still takes it when
  nothing else has room, as with the reserve (the ops worker follows its own rule, w1112). The reason names the line ("weekly 96% (stop line 95%), resets in
  12 h"), and it lifts at that window's reset. *What this changes in the caps:* the 5-hour meter was already covered (80% holds the
  token for every worker); the weekly meter was covered by the reserve buffer except on the last day before the weekly reset, when
  the buffer (5% a day) falls under 5% and 95-99% weekly was the `one-at-a-time` band with its slot free (the dispatcher takes no
  slot), so a worker could still start there. The stop line closes that gap. Without a pinned token there is no stop line: the
  dispatcher is then on its payer's pool, whose own caps hold it like anyone's.
- `system_status` shows a crossing in progress ("Dispatcher token stop (w1109): ... N worker(s) asked to save and stop, still
  working: ..."), and the server log has a `token stop:` line for each ask, interrupt and block.

**The dispatcher on a vault token (w996).** `claudeAccounts.dispatcher` takes `"vault:<entry name>"`, e.g.
`"vault:vault-lothsahn-1"` (lothsahn, 2026-10-11: "Please make Lothsahn's token the dispatcher token"). It is one named token,
not "a person's pool": the dispatcher has no person, picking from a pool by score would put it on whichever token scores best
that day rather than the token asked for, and the reserve needs one credential to sit on. An owner's setting
(`OWNER_ONLY_KEYS`, `server/appConfig.ts`); `set_app_config` refuses a name that is not an enabled Claude entry the key opens, and the
config check refuses the value for the orchestrator. What it changes, each point *read* from the code:
- **The process.** The dispatcher starts with that token alone (`pinnedDispatcherEnv`, from `orchestratorEnv` in
  `server/agents.ts`), at each process start; a running dispatcher keeps its account until its process restarts. The entry
  needs no role or machine grant, and does not have to be the dispatcher's person's: the setting is the consent.
- **Unpinned (w1078).** With no pin (`claudeAccounts.dispatcher` unset, or `"vault"`, which `set_app_config` stores as no key),
  the dispatcher runs on the system payer's pool (`poolRunEnv` with `identity.systemPayer()`), picked like an orchestrator's.
  Before w1078 it stayed on the token file or the host token.
- **The reserve moves with it** (`reservedCredentials` in `server/secrets.ts`). The 5%-a-day weekly and 20% 5-hour buffer
  (the numbers above, `vault.pool.reservePerDayPercent` / `reserveSessionPercent`) is kept on that token from the next look,
  matched by its fingerprint. So the rule holds on the pinned token: no new worker, standing agent, ops worker or orchestrator while the
  person's other tokens have room; when none does, the orchestrator takes it, the ops worker takes it once the person's other tokens
  are used up (w1112), and workers **wait**. *Consequence worth knowing:*
  on a pool of **one** token, the person's workers wait whenever that token is inside the buffer (e.g. weekly above 75% with five
  days to the reset, above 95% with one). With two or more
  tokens workers move to the others. The dispatcher itself is never held: it may run into the buffer up to 100%.
- **The dispatcher takes no pool slot** (`liveOnAccount`): its own live process is not counted toward the one-at-a-time slot
  (95% to 99% weekly) of the token it is on, and not toward the "N running" the held reasons give. *Why* (a design call,
  not measured): the reserve is already the rule that protects the dispatcher on that token; counting its always-on
  process as well would hold the token's one slot for the whole last part of the week, so the person's workers could never
  use it there, which is more than the reserve asks. The two rules only differ in the last day before the weekly reset, when the
  buffer has shrunk below 5% and 95% or more is the one-at-a-time zone and no longer inside the buffer. The dispatcher is
  still named under the token in `system_status` ("N running: …"). Workers and the person's orchestrator count as before.
- **If the vault cannot give the token** (entry removed or disabled, key missing or wrong) the dispatcher does not start
  (w1078; before, it ran on the token file or the host token): `pinnedDispatcherEnv` throws `PoolHeldError` with "the dispatcher
  is pinned to vault token <name> (claudeAccounts.dispatcher), but the vault has no usable Claude entry of that name, so it
  does not start: fix the entry (`fffctl vault list`), or pin another", which the log, the start error and `system_status`'s
  vault warning show. `set_app_config claudeAccounts.dispatcher "vault:<other name>"` pins another; `"vault"` (or `null`)
  puts it on the payer's pool. Only those forms are accepted: `"token"`, `"login"` and `"tokenfile"` are retired.

**Which account runs what (w1078).** Every Claude process is on a vault token and no other credential: it starts with that
token as `CLAUDE_CODE_OAUTH_TOKEN` alone, every other Claude credential removed first (for a machine's run the daemon drops its
own with `LaunchSpec.login`, so an `ANTHROPIC_API_KEY` in its environment cannot outrank the token). A person's orchestrator
and the ops worker run that way in the portal (`poolRunEnv`); workers and standing agents on every machine run that way
(`machineRunEnv`), on the pool of the person their work is for (section 10). The old switches (`userClaudeEnv`,
`machines.claudeFromVault`, `machines.useHostClaudeEnv`, `claudeAccounts.orchestrator`) are retired and ignored if a config
still sets them; the portal's start takes them out of config.json ([accounts.md](accounts.md)).

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
- **A reading outlives a restart and a failed poll (w1041).** `data/usage.json` already held each credential's last reading
  and loaded it at startup, but a failed poll replaced a token's reading with "unknown" (no numbers), and an unknown reading
  counts 50% on both windows, and "no reading" counts as inside the dispatcher's reserve (`reserveOf`). On 2026-10-11 at
  20:30Z (14:30 local) the deploy restarted the portal; the first poll of vault-lothsahn-1 got **429 (Retry-After 60 min)** from
  the endpoint and "fetch failed" from the headers call, the saved 8% / 28% was overwritten with unknown, and the pool showed
  `reserved` until the 14:32 poll read the headers (*measured, portal journal 2026-10-11 14:29 to 14:33 local*). Now:
  - a failed poll keeps that token's own last reading with the failure (`UsageEntry.usage.error`); only a 401 (token rejected)
    drops it, because old numbers would hide that the token cannot run;
  - every reading the scheduler and `system_status` use goes through `effectiveUsage` (`server/usage.ts`, via
    `UsageTracker.usageOf`): a window whose reset time has passed counts as **0%** (the weekly one rolls forward by whole weeks),
    and a reading this process has not read itself, or whose last poll failed, is labelled `[persisted reading: read 12 min
    ago; ...]` in the pool lines, the reserve lines and the accounts list;
  - **staleness bound: 6 hours** (`STALE_READING_MS`). Older than that, a window not yet reset counts as at least 50% (the same
    assumption as a token never read); a high old reading stays high, because a window's counter only goes up before its reset.
    Why six: longer than the endpoint's 60-minute Retry-After and several 15-minute polls, longer than one 5-hour window, and
    short enough that the weekly counter cannot have moved far (vault-lothsahn-1 read 6% at 13:29 and 8% at 14:32 local,
    +2 points in an hour, measured: about +12 in six hours at that pace). A guess for a heavier pace;
  - the endpoint's refusals are persisted too (`holds` in `usage.json`: a 429's Retry-After and a 403's six hours, by token key),
    so a restarted portal does not ask again inside them;
  - a token on a kept reading is polled at the 2-minute near-poll pace until a poll answers.
  The file holds the token's key (a hash prefix), its label (name and last four characters) and numbers; never a token.

## 5. Security review

| Threat | What stops it |
|---|---|
| A worker machine is compromised | It holds only its machine token. With it, it receives what the portal sends its runs: the Claude token chosen for each, and the entries granted to that machine. It cannot list the vault, ask for an entry, or see another machine's grants. Revoke the machine (one command) and rotate what it was granted; the vault shows exactly which entries name it |
| An agent on a worker machine reads its environment | It sees its own run's secrets, as today (it must, to use them). The vault narrows that from everything in the machine's keyring to what its run needs |
| The data folder leaks (a backup, `fffctl migrate`, a copy) | `vault.json` holds ciphertext; the key is never in `data/` or a backup |
| An orchestrator on the portal (the same OS user) goes for the key | The secret guard refuses reads of `vault.keyFile`, `/etc/fff`, `/run/credentials` and `$CREDENTIALS_DIRECTORY` (`portalSecretRules`), as it refuses `data/` and the secrets folder, and the variable is removed from the agents' environment. This is a seatbelt, not a boundary: a shell command of the same user can still read the credential while the service runs. The boundary is the one D2 accepted |
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
3. **Switch one machine at a time (until w1078):** `set_app_config machines.claudeFromVault true machine: "<id>"`, m3 first, then
   m5, LothDesktop, BEAST. Its next agent process ran on a vault token, running ones kept theirs; a machine that was offline
   took the vault path at its next process (w737). **w1078 ended the switch:** every machine's runs take a vault token, the key
   is retired and the portal's start takes it out of config.json. If the vault cannot give a token (the key is unreadable, no
   entry is eligible for the run's person) the run does not start and says why (section 4, "No token, no run"); it used to
   fall back to the host token or the machine's own login.
4. **Grant the other secrets** to that machine, then check that a worker there can `gh auth status` and push, and, on
   the posting machine, that `ffdiscord` posts.
5. **Retire the machine's own logins** (`claude /logout`, and LothDesktop's Discord token in `secrets.env`): no run uses a
   machine's Claude login since w1078, so they are only stale credentials on the machine. **Keep the
   machine's `gh` login** (w868): the daemon's own fetches (a new sandbox, the base refresh) and the pushes of a branch
   handover still use it (section 13.3).
   Until a machine's login is retired, a Claude process a worker starts itself from its shell (`claude -p`, a script on
   the Agent SDK: a measurement, a replay) does not get the worker's vault token, which is only in the agent process's
   environment, and silently runs on that login: someone else's account (w1158: the first context probes on biscuit ran
   on biscuit's own login, about $1.70, and that login then answered with its seven-day limit). Give such a process the
   agent's own token (`CLAUDE_CODE_OAUTH_TOKEN` of the agent process, `/proc/$PPID/environ` on Linux; never print it)
   and check its last four characters against the worker brief's "Claude account" line before the first call.

**Rolling back** a machine's grants: take the machine out of the entry's grants. A Claude token has no machine to roll back
to (w1078); a release from before w1078 would read `claudeFromVault` again, which the newer release's start removed
([portal-on-ffbox-host.md](portal-on-ffbox-host.md), 7.5a).

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
  several machines (before w1078 the host token on BEAST and the Macs; now a person's vault token). Several machines on one token share one budget; section 4
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

- **Built (w738, w739, w1078):** the orchestrators on vault tokens: each person's orchestrator, and the ops worker working for
  them, runs on that person's pool (section 4). w1078 finished it: the dispatcher is on a vault token too (pinned or the
  payer's pool), `claudeTokenFile` is gone and the portal deletes `/srv/fff/secrets/claude-oauth-token`.
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

**The rule.** A worker run gets the Claude token and the GitHub token of the person its work is for, and nobody else's. w1031
(lothsahn, 2026-10-11: "When a user on fffactory answers an intake question or otherwise updates a work item it should switch
to them going forward. Use their Claude and GitHub tokens. Likewise intake should use my Claude and GitHub tokens. Discord inputs
should follow ben if it's Ben's user requesting or mine if it's my user.") put one rule above the table: **the person who last
acted on a request is the person its workers run for** (`WorkItem.runsFor`, below). The table is the answer for a request nobody has
acted on since it was filed.

| The run | Whose tokens | Where the code decides |
|---|---|---|
| A request a person filed (their orchestrator's `request_work`, a trusted Discord request to Max) | that person's | the run's `requestedBy` (`machineRunEnv`) |
| A worker a person's orchestrator started directly | that person's | the same (`actingFor`, the author of the message it serves) |
| A request both people asked for (one merged into the other) | the person who filed it first | `WorkItem.requestedBy`; a merge adds people to `requesters` only (the merge in `Orchestrators.decide`, `server/orchestrators.ts`), and the dispatcher's `work_id` starts run as `requestedBy` (`dispatcherActor`). *Why:* it is the one requester the ledger already bills and attributes the request to; picking per run among `requesters` would make two runs of one request land on different accounts |
| Intake work nobody named: Discord bug reports, FFBox reports and diagnoses, release follow-ups | config `vault.unattributed.intake`, default `lothsahn` | `WorkItem.unattributed` (set by `fileIntake` when no person asked), `unattributedKind`, `tokenPersonForWork` |
| FFBox-filed work naming no operator | `vault.unattributed.ffbox`, default `lothsahn` | the same |
| FFBox work naming an operator (an ffdev dev request, an operator's escalation) | that operator's, mapped to the FF Factory login of the same name | the request is filed for them (`fileDevRequest` from `server/devRequests.ts`; an operator's escalation in `server/intake.ts`), so it is not unattributed |
| A request filed from a nightly lab regression (source `nightly`) | `vault.unattributed.intake`, default `lothsahn` (w1031: the brief counts the lab's regressions as the intake's) | `unattributedKind` |
| The nightly run and review jobs (sources `nightly-run`, `nightly-review`), the nightly regression sentry and the workers its delegations start | `vault.unattributed.nightly`, default `lothsahn` (w1031: "Yes, move the nightly jobs to me"; was `ben`) | `unattributedKind` (or a delegation from `nightly-regression-sentry`); the sentry's own runs in `server/standing.ts` |
| Anything else no person asked for | the system payer's (config `systemPayer`) | `machineRunEnv` |

**Take-over on action (w1031).** When a person acts on a request in FF Factory, `Orchestrators.takeOver` (`server/orchestrators.ts`)
sets `WorkItem.runsFor` to them, and `tokenPersonForWork` (`server/vault.ts`) then returns them ahead of every row of the table.
Acting is one of these, from a login that exists, through the web UI, the person's orchestrator or FFBox:

| Action | Where it is caught |
|---|---|
| answers a question (a design question, the intake's or the dispatcher's) | `updateNow` (a note on a request with a question), `answerFromFfbox` |
| approves or declines an intake request | `approveIntake`, `declineIntake` (the web routes, `update_work approve/decline`, a recorded conditional decision) |
| adds a note | `updateNow`, `noteForOther` (another owner's request) |
| reopens | `updateNow`, `closeForOther` |
| changes its priority, or presses Start now | `updateNow`, `bumpWork` |
| files it again, or joins it from Discord or FFBox (a known person's own input) | `fileNow` (repeat), `fileIntake` (repeat with a person), `fileDevRequest` (covered), `DevRequests.onMessage` |

`update_work` counts only in a turn the person started with their own message (`turnFrom`/`lastFrom` is `human`). A worker's report,
a harness message, a relayed Discord or FFBox text and the dispatcher's own decisions never count (`decide`, the ledger sweep,
`fileDelegation` do not call `takeOver`). The switch is logged on the request ("now runs for Lothsahn: Lothsahn pressed "Start
now" (was ben; …)"), shown on its row in the dashboard and in `list_work`, and applies from the worker's **next turn**
(w1076, below). `SessionInfo.ranAs` keeps the account each process started on, so `spend_report` attributes every turn to the
account it ran on (`docs/spend.md`).

**One person's tokens per turn (w1076).** lothsahn: "Why was that running on Ben's account? I messaged that on discord. It
should have run on my account" (his w1072 was sent into Ben's worker a33e1437 and ran on Ben's pool until Ben's session limit).
Every turn a worker spends on a request runs on that request's person's tokens (`personForWork`: `tokenPersonForWork`, else its
requester). Of the options weighed, a session's process does not switch account per message: a Claude Code process takes its
token at start, a message that arrives mid-turn joins the turn in flight, prompt caches do not carry across accounts, and a
session with two people's requests would bill each for re-reading the other's context on every turn. Instead:

- **One person per session.** A request never goes into a session that has another person's open request in hand
  (`Orchestrators.accountClash`): `message_agent` starts a new session in the same sandbox, `decide_work link` is refused
  (docs/orchestrators.md, "One person per session").
- **The session's person is its requests' person**, read at every process start (`machineSandboxSpec` → `tokenUserOf` →
  `Orchestrators.sessionPersonOf`, `sessionPerson` in `server/vault.ts`), not whoever started the session; a new worker's first
  process uses the request it was started for (`startWorker`'s `workId`), since it starts before the ledger links it. Two
  people in one session anyway (a take-over of one of several requests, or a join from before w1076): the person it last ran
  for keeps it, so it never flips, and the other request moves out on its next `message_agent`.
- **A live process follows its person at a turn boundary.** `SessionInfo.ranFor` is whose pool token
  its process started on (`MachineRunEnv.person`). When its requests now name another person (a
  take-over), the next message waits (`SessionManager.accountMove`, `moveFor`): an idle process is stopped and the message
  starts a new process on the new person's tokens in the same conversation; a process mid-turn finishes that turn first.
  Not while it runs a background task (a build the restart would kill): that process carries on until it ends. The daemon's
  session reports never overwrite `ranAs` or `ranFor` (it keeps the copy of the first start).
- **A limit is its own account's.** The ledger cleanup does not hold a request on another person's usage limit: a worker that
  stopped on a limit while holding another person's request gets that request moved (the dispatcher is told), and a worker
  whose next process runs on another person's tokens than the account at its limit is resumed at once.

**No fallback (w1031, for everyone since w1078).** A person never runs on the host token, a machine's login or another
person's token: when none of theirs is eligible because the vault key is gone or none opens, the run does not start and says why
with a `PoolHeldError` (`machineRunEnv`, section 4 "No token, no run"); a pool at its caps is held. Until w1078 a person with no
Claude token in the vault at all kept a transition fallback, and a machine with `machines.claudeFromVault` off was outside these
rules; both are gone.
A GitHub token missing for the person (`machines.githubFromVault` on) gets a host notice, once per person, machine and day
(`VaultContext.onGithubMissing`, `hostNotice`), besides the `system_status` line; the run still uses the machine's own gh login,
so it pushes as that login, not as the person (decision 13.3: a push is not held for a token).

The token person changes only which vault entries a run gets. Who a request is billed to in the ledger, who hears
about it, and the usage attribution stay as they are.

**Tokens are not shared across people.** Every per-person entry is `share: owner`. A run whose person has no token in
the vault gets nobody else's: it does not start, and `system_status` warns (w1078; before, it ran on the machine's own login or the host token). Change the defaults with `vault.unattributed` in `config.json`, e.g.
`"vault": { "unattributed": { "intake": "lothsahn", "ffbox": "lothsahn", "nightly": "ben" } }` (user ids).

**Setting it without editing config.json (w1289).** `set_app_config` takes `vault.unattributed.intake`, `vault.unattributed.ffbox`
and `vault.unattributed.nightly` (`server/appConfig.ts`; lothsahn, 2026-10-14: moving the nightly review and its regression
jobs onto Ben's pool). Each value is a user id, and the change is checked before anything is written:

- **A login that exists.** An unknown id is refused, naming the logins (`identity` users). The id is stored in the login's own
  spelling (`Ben` becomes `ben`).
- **A person with a Claude pool.** `Vault.hasClaudeFor` (`server/vault.ts`): an enabled Claude entry the person owns that the
  vault key opens. A person with none is refused, because every run of that kind would then not start ("No fallback", above).
  With no vault loaded in the process the check cannot be made, so the change is refused.
- **`null` clears the key** back to the default (`UNATTRIBUTED_DEFAULTS`: `lothsahn` for all three kinds). It is always allowed,
  needs neither a login nor a pool, and removes `vault.unattributed` from `config.json` once its last key is gone. (A `null`
  that was refused would leave no way back to the default short of editing the file by hand.)
- **The owner's only**, like `claudeAccounts.dispatcher` (`OWNER_ONLY_KEYS`): the dispatcher runs it for a request an owner asked
  for in their own words (`work_id`), or from an owner's own orchestrator.
- **Live, no restart.** `setAppConfig` updates the running config object, and every reader looks the person up when it needs
  them and keeps no copy from startup: `unattributedPerson` and `tokenPersonForWork` (`server/vault.ts`) from the token picks and
  `machineRunEnv`, the standing-agent launch for the Nightly Regression Sentry (`server/standing.ts`), and the nightly review's
  filing (`onNightlyWorkerTurn`, `server/intake.ts`). The next run or process start of that kind takes the new person; a request
  a person has acted on (`runsFor`) stays with them, as before. A live process follows at its turn boundary (w1076).

Changing `vault.unattributed.nightly` changes whose Claude pool and GitHub token the nightly run, review and sentry jobs use, and
nothing else about the nightly: `intake.nightly.run.person` and `intake.nightly.review.person` stay as set (that login hears a
missing or broken night). One consequence is older than this setting: the review jobs the nightly merge review files
(`onNightlyWorkerTurn`) are filed with the nightly person as their owner, so with `nightly` set to `ben` they are Ben's requests
in the ledger and his orchestrator hears their reports.

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
The Claude usage sheet and the footer's plan line name a plan by it (`AccountUsage.vaultEmail`, a display field apart from `email`, which usage gates match; w1389), the vault name ("ben-2") when none is recorded; the full address and the vault name are on the row's hover.
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

A fine-grained token reaches only Final-Factory's repositories. Another account's private repositories (a modder's) are
reached through a GitHub App that account installs, kind `github-app`: [github-apps.md](github-apps.md) (w1519).

- **Code:** `server/githubTokens.ts` (the switch `githubFromVault`, the portal's runner `ghRunner`, the daemon's token
  `forMachine`, the probe and the health lines), `Vault.githubFor` / `Vault.githubTokens` and the `github` option of
  `Vault.forRun` (`server/vault.ts`), the GitHub part of `machineRunEnv` (`server/secrets.ts`), `githubToken` on the
  `switch` and `save_work` messages (`server/machineProtocol.ts`, `githubNetEnv` in `machine/daemon.ts`), the vault page
  (`GithubHealth` in `web/src/components/Vault.tsx`). Tests: `server/githubTokens.test.ts`, the GitHub cases in
  `server/vault.test.ts`.
- **The tokens are the ones sections 10 to 12 already carry:** `people/<person>/github-token` on the FFBox host, synced to
  the entry `vault-<person>-github` (`share: owner`, workers and standing agents on every machine). Nothing new to install
  on a machine, no second store.
- **Off until switched on.** One owner-only setting, `machines.githubFromVault`, per
  machine (true, false, or an object with `"*"` for the rest), `"*"` for the rest, and the machine id **`portal`** for the portal's own reads. Before w868 a GitHub entry went
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
| Final-Factory/FinalFactory (internal) | workers push branches, open and merge PRs into master, read and re-run CI; the portal reads PR states and CI | required |
| Final-Factory/ff-factory (public) | workers' PRs to this portal, merged on green; the ledger sweep reads its PRs | required |
| Final-Factory/final-factory-agents (public) | skills and lessons (`publish-skills`) | required |
| Final-Factory/ffbox (private) | workers push fixes to ffbox master one at a time (w857's brief), read its code | required |
| Final-Factory/finalfactory-agent-kit (public) | the players' HowToPlay (`learnToPlay`) | required |
| Final-Factory/ff-marketing (private) | marketing skills' work | required |
| Final-Factory/ff-orchestrator-memory (private) | the orchestrators' memory (the portal's D7 push) | required |
| Final-Factory/KNN (internal) | the game's KNN package (lothsahn, w904) | required |
| Final-Factory/Facepunch.Steamworks (public) | the game's Steamworks fork (lothsahn, w904) | required |
| Final-Factory/ff-factory-private, multiplayer-community-contributions, nevergames-website | none found in this repo's code or briefs | no ("All repositories" covers them anyway) |
| Final-Factory/FinalFactoryModTemplate (public) | the mod template (game repo `CLAUDE.md`, "Modding"); moved from bryding/ into the organization (w1650), where a vault token's push and pull request worked | required |
| Lothsahn/* | personal repositories | **cannot**: a fine-grained token has one resource owner. With `GH_TOKEN` set, gh and git use only it, so work on these fails with the person token; such work needs a run without the switch (its machine `githubFromVault` off) |

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
  (w1137 retires `develop`; this is the state before.) `develop` has only the ruleset "Protect master and develop from rewrites" (no deletion, no force push, no bypass actors) and
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
spec is old). Keep each machine's own gh login: the fallback, and the daemon's own fetches (13.1). Each daemon reports that
login's account and scope names (w1463, never the token; docs/machines.md, "Work that changes `.github/workflows`"), so
list_machines, the briefs and placement know which machines may push a workflow file; where this switch is on, a person's
vault token counts in its place for their work.

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

**A rate limit is not a missing permission (w1186).** On 2026-10-13 about 00:47 UTC GitHub's rate limit on lothsahn's account
(403 "API rate limit exceeded for user ID 10092359") refused the probe's Artifact metadata and Self-hosted runners reads and
the banner said "read refused", and lothsahn was asked to edit a token that had those permissions all along. The probe now
tells the two apart from the real answer's own headers and body, never from `gh api rate_limit` (it reported 5000 left all
night while real calls were refused): a 403 or 429 with `X-RateLimit-Remaining: 0` or a `Retry-After` (a secondary limit),
or any answer whose message says "rate limit exceeded" or whose GraphQL error is `RATE_LIMITED` (server/githubTokens.ts
`rateLimitOf`). A rate-limited read stops the probe where it is and **keeps the credential's last verdict** (what it lacked,
when it was read); nothing is counted as refused, no token banner and no `[host]` notice is raised for it, and the token is
still used. A separate banner **"GitHub is rate limiting us."** (kind `github-rate-limit`, for the token's person and the
owners, one per GitHub account since its tokens share one budget) names the token or tokens, the account, GitHub's words and
the reset time from `X-RateLimit-Reset` (or `Retry-After`); without one the credential is read again every 10 minutes. The
credential is not probed again before the reset, and the banner clears by itself on the first good call after it (the
probe's own, or any portal gh call that succeeds on that credential). The CI-read check (w889) keeps its last measurement
the same way. `system_status` shows `RATE LIMITED by GitHub (…)` on the credential's line.

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

From then on only the person's pool serves their runs (section 4). Since w1078 someone with no token in the vault has no
account: their runs do not start until `sudo fffctl vault add-claude <id>` (or a file above) gives them one.

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
token pools" section, one line per token: its last four characters, its label (`pool:ok`, `pool:one-at-a-time`, `pool:held`, `pool:retired`,
`pool:exhausted`, `pool:reserved`, with ` priority` on the one a new job gets), its 5-hour and weekly percent with their resets, and how many agents ran on it at the portal's last save.
`system_status` has a "Claude token pool, <person>" line per person with the same, the agents running on each token, and
a verdict, plus a line per reserved credential ("the dispatcher's vault token vault-ben-2 …dAAA: weekly 41%, reserve 25% (5 days to
reset)…"). A token whose line says "no numbers yet" has not been polled: wait for the next poll (2 to 15 minutes).

**3c. The orchestrators on their own pool (w738; the only way since w1078).** Once a person's tokens are in, their orchestrator
starts on their pool at its next session start (a running one keeps its token until its process restarts, so restart them from
the dashboard or wait for the next idle stop), and the ops worker picks the pool of whichever person's orchestrator gave it the
job, at the start of every job. `system_status`'s "Claude account per agent" line says "every one a vault token", and each pool
line names the orchestrator's token. There is no setting for it any more and no rollback to a token file: a config from before
w1078 gets `claudeAccounts.orchestrator` written out as `"vault"` (the only value) by the portal's start, set or not, so an
older release rolled back to also finds them on their pools.

**4. Max's Discord token, for the posting machine only** (in the VM; unchanged):
`sudo fffctl vault add --kind env --env FFDISCORD_APP_TOKEN --name max-discord --share anyone --machines lothdesktop --file /tmp/d && shred -u /tmp/d`.

**5. Workers on the vault (every machine, since w1078).** There is nothing to switch on: a worker started on any machine for
lothsahn's request says "vault token vault-lothsahn …abcd" in its brief, and `gh auth status` there shows his token (where
`machines.githubFromVault` is on); one for Ben's request shows Ben's. Before w1078 lothsahn switched `machines.claudeFromVault`
on per machine (m3, m5, lothdesktop, beast); the portal's start removed that key.

**6. Retire each machine's own Claude logins** (section 6, step 5): nothing runs on them any more.

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

**Rollback of the Claude accounts (w1078):** there is no setting that puts a role back on a host token, token file or login.
Rolling the portal back to a release from before w1078 is `fffctl rollback` (it puts FFBox's connector hash back into
config.json; [portal-on-ffbox-host.md](portal-on-ffbox-host.md)) and nothing else: the start kept the old config.json,
host token and token-file keys included, in the secrets folder as `config.json.before-w1078-<time>`, for a person to restore by
hand. A machine to cut off
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

## 14. Secrets in what the portal keeps, and the scrub (w1584)

A worker's failing test printed its vault GitHub token (`GH_TOKEN`, ff-factory PR #445, w1519). The value reached two places:
the model (the tool result) and Claude Code's own transcript on the worker's machine
(`~/.claude/projects/<cwd>/<session>.jsonl`), which nothing of FF Factory writes. Since then:

- **Tests never see a credential.** `npm test` and `npm run test:coverage` load `scripts/testEnv.ts` first (`node --import`),
  which deletes every variable named like one (`shared/secretShapes.ts` `SECRET_ENV`: `*_TOKEN`, `*_KEY`, `*_SECRET`,
  `*_PASSWORD`, `*_PAT`; a vault env-kind entry must have such a name, `envNameProblem`) or holding a token-shaped value.
  `scripts/testEnv.test.ts` plants fake tokens in the parent environment and checks no test process (or a process it
  starts) sees one.
- **Every store masks before it writes or sends.** Transcript events (`server/store.ts`), and now also session records and
  standing agents and delegations (`state.json`), work items (`work.json`: the log, DONE reports, `[needs you]` text, notes),
  every event a page hears (`emit`), push notifications, the daemon log, and text attachments on arrival (`.log`, `.txt`,
  `.json`, `.jsonl`, `.md`, `.csv`, `.yaml` up to 64 MB, kept under the SHA-256 of the masked copy). Search reads the
  transcripts, so it never had its own copy. Masking (`redactSecrets`, `redactValue` string by string): every value the vault
  holds, and the shapes `ghp_` `gho_` `ghs_` `ghu_` `ghr_` `github_pat_`, `sk-ant-…`, PEM private keys (whole or cut off),
  `ffm_`, `ffsb_`, `ffpv1_`, `tskey-`, age keys and Discord tokens, each to its last four characters
  (`github_pat_[redacted …yVC9]`). The GitHub shapes had a look-behind that let a token through after a JSON `\n` or a
  terminal colour code; that is gone.
- **The scrub** (`server/scrubSecrets.ts`) masks what is already on disk. The portal runs it over its data folder at start,
  once per `SCRUB_VERSION` (`<dataDir>/secret-scrub.json` records it), logging paths and counts. By hand:

  ```sh
  sudo fffctl scrub-secrets --dry-run   # counts only; the ops worker may run this one
  sudo fffctl scrub-secrets             # masks in place: the data folder and the portal account's ~/.claude/projects
  ```

  It prints one line per file that held secrets (`<path>: redacted N`, never a value), a total, and last `remaining: N`.
  `remaining: 0` means nothing is left. It never rewrites the vault, keys, logins, `vapid.json`, `config.json`, the
  attachment and upload stores, or the live `state.json` and `work.json` (the portal masks those itself at start), and leaves
  a file changed in the last two minutes (named; run it again). On a worker machine, with the release's checkout:
  `node server/scrubSecretsCli.ts --no-data --claude-projects ~/.claude/projects [--dry-run]`.

What masking cannot reach: what the model already read, and Claude Code's transcript on the worker's machine while it is being
written. A run's `GH_TOKEN` is in its environment by design (`gh` and the git credential helper read it), so `env` in a
worker's shell still shows it to the model; only keeping it out of the environment would change that.
