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
| The workers' GitHub token (push, PRs, `gh`) | every worker | gh's login in each machine's keyring (BEAST: Windows Credential Manager, git's helper `gh auth git-credential`; measured in w511) | **Moves**: kind `github`, given as `GH_TOKEN`, plus a git credential helper that reads it (`githubCredentialEnv`). Which account owns it is w511's open decision 4 |
| Max's Discord bot token (posting as Max) | runs that post as Max (LothDesktop's today) | `~/.config/ffbox/secrets.env` and `config.json` on LothDesktop | **Moves**: kind `env`, `FFDISCORD_APP_TOKEN`, granted to the posting machine only. *Measured:* `ffdiscord.py:9,236-238` (ff-discord plugin) reads `FFDISCORD_APP_TOKEN` from the environment before any file. `FFDISCORD_SERVER_ID` is not a secret and stays in the machine's config |
| Any other API key a run needs later | as granted | — | kind `env`, any variable ending `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD` |
| The machine token (`ffm_<id>_…`) | the daemon, to reach the portal | `daemon.json` (w511 moves it to `secrets/machine-token`) | **Stays**: it is the enrollment credential, the one thing a machine must hold to be given anything |
| The outside watch's ntfy topic | the M5's daemon | `outside-watch.json` in the daemon's folder | **Stays**: it must raise the alarm while the portal is down, so it cannot depend on the portal. The portal already sends it (`outside_watch`); the machine keeps the copy |
| ssh keys (`~/.ssh`: peer runs, the portal's deploy key) | lab and audit scripts, `add_machine` | each machine's `~/.ssh`; the VM's `/srv/fff/home/.ssh` | **Stays**: a key is tied to the peers' `authorized_keys`; the deploy key is the portal's own |
| Unity's licence activation | the editors | each machine | **Stays**: Unity binds it to the machine |
| The self-hosted GitHub runner's registration (BEAST, `finalfactory-mode2-windows`) | the game repo's CI | `C:\Users\rydin\actions-runner-finalfactory-mode2\` | **Stays**: GitHub's runner, outside FF Factory |
| steamcmd's login cache (M5, `~/.steamcmd-home`) | last-resort manual uploads (`mp-beta-deploy`) | the M5 | **Stays**: a person's own login, used by a person (w511 5.1); releases go through ffbox CI |
| FFBox's config and secrets (`~/.config/ffbox`, its connector token) | FFBox | FFBox's host, LothDesktop | **Stays, never shared**: the "nothing shared with FFBox" rule (D8) |
| `AgentControl/session-*.json` bearer tokens | the game's agent automation | the game's data folder | **Stays**: the game makes one per session, for local use only |
| The portal's own: its GitHub token (D7), Lothsahn's subscription token for the orchestrators (D4, `claudeTokenFile`), its Discord token copy, web-push keys, API keys | the portal | `/srv/fff/secrets`, `/srv/fff/home`, `data/` | **Stay as they are**: no worker uses them. The orchestrators could move onto vault tokens later ([section 9](#9-follow-ups)) |

## 2. The vault on the portal

**One file, `data/vault.json`, sealed value by value.** Each entry keeps its metadata in the clear (id, name, kind,
owner, grants, fingerprint, last four characters, dates). Its value is AES-256-GCM ciphertext with a fresh 96-bit IV,
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
- **Elsewhere** (a portal still on Windows, the e2e tests): config `vault.keyFile`. `loadConfig` refuses one inside
  `data/`; `readKey` refuses one other users can read (Linux, macOS).
- **No key, or the wrong one:** the vault still lists, but hands nothing out. Every run falls back to what it had
  before (section 4) and `system_status` says why.
- **Never in a backup:** `fff-backup` packs `/srv/fff` only (`tar -C "$FFF_ROOT"`, `deploy/vm/guest/fff-backup:36`).

**Adding, rotating and removing.** There are two ways in, and neither goes through chat:

- `sudo fffctl vault add|rotate|grant|remove|list` in the VM. A value is read from a file (`--file`) or stdin, never
  the command line, where any process could read it. Root's writes are handed to the `fff` user.
- The owner's settings dialog (Settings → Token vault), backed by owner-only routes (`/api/vault`). A member gets 403.
  An API key cannot reach them: `/api` takes only a signed-in browser session.

**A value is never shown back.** Everything that lists the vault shows its name, kind, owner, grants, fingerprint and
last four characters. The fingerprint is the first 12 hex characters of the value's SHA-256, the same key the usage
meters use for a Claude token (`tokenKey`, `server/usage.ts`). No route, tool or command returns a value. The
orchestrators get no vault tool; `system_status` gets one summary line.

**Kinds:**

| Kind | Value | Given to a run as |
|---|---|---|
| `claude` | one `sk-ant-oat01-…` token | `CLAUDE_CODE_OAUTH_TOKEN`, one per run, chosen by section 4 |
| `github` | a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) | `GH_TOKEN`, and a git credential helper for `https://github.com` that reads it |
| `env` | any value of 8 to 4096 characters, no whitespace | the entry's variable, which must end `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD` and may not start `CLAUDE_`, `ANTHROPIC_`, `GH_`, `GITHUB_` or `GIT_` |

**Grants.** Each entry names the roles it serves (`workers`, `standing`), the machines (`*` or ids), an owner (a portal
user id) and who may use it: `share: owner` (only work its owner asked for, the default) or `share: anyone`.

## 3. Distribution

**Enrollment is the machine token.** Each daemon already proves who it is with its own 256-bit token on the WebSocket
(`/machine`). The portal keeps only its SHA-256 and compares in constant time (`MachineManager.authenticate`). It is
per machine and revocable:

- `fffctl machine-credential issue <id> --out FILE` writes a fresh credential for a machine to a 0600 file and never
  prints it (for w513's installer). `add_machine` keeps issuing one as it does today.
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
- **Only what that run may have.** A run gets one Claude token and the other entries granted to its role and machine.
  Another machine's grants never reach it.

**When the portal is down, nothing new starts.** That is how it already works: no portal, no `send`, no new process.
Running agents keep the environment they started with and carry on. There is no cache on the machine to steal or to
expire. When the portal is back, the next start gets current values, so a rotated token applies from then.

## 4. Which Claude token a run gets

`pickClaude` (`server/vault.ts`) chooses among the `claude` entries:

1. **Eligible:** enabled, granted to the run's role and machine, and either shared or owned by the person the run is
   for. A run nobody asked for counts as the system payer's (config `systemPayer`, else the owner).
2. **The person's own first:** an entry the run's person owns ranks above the shared ones.
3. **Room left:** an entry whose 5-hour or weekly meter is at 95% or more ranks below every entry with room. Among the
   rest, the most headroom first, `100 - max(session %, weekly %)`, from the numbers the usage meters already poll for
   each vault token (`UsageTracker`, every `usagePollMinutes`). An entry with no numbers yet counts as 50%.
4. **Spread:** then the fewest live sessions on that token, then the name.
5. **Sticky per session:** a session keeps its token while it stays eligible and under 95%, so a resumed process does
   not hop accounts. The choice is made at each process start, never mid-process.

One token can serve several machines at once. The meters show its 5-hour and weekly use across all of them, because
those limits are per account (section 7).

**Order with the existing switches.** A person's own token in config `userClaudeEnv` still wins for their work, as
before. Next comes the vault, on machines `machines.claudeFromVault` names (owner-only in `set_app_config`). With no
eligible entry, or no key, the run falls back to what the machine had without the vault, the host token or its own login
(`machines.useHostClaudeEnv`), and `system_status` shows a warning for 24 hours. A vault token is given with
`LaunchSpec.login` set, so the daemon drops its own environment's credentials (an `ANTHROPIC_API_KEY` there would
outrank the token) and the token is the process's only one.

## 5. Security review

| Threat | What stops it |
|---|---|
| A worker machine is compromised | It holds only its machine token. With it, it receives what the portal sends its runs: the Claude token chosen for each, and the entries granted to that machine. It cannot list the vault, ask for an entry, or see another machine's grants. Revoke the machine (one command) and rotate what it was granted; the vault shows exactly which entries name it |
| An agent on a worker machine reads its environment | It sees its own run's secrets, as today (it must, to use them). The vault narrows that from everything in the machine's keyring to what its run needs |
| The data folder leaks (a backup, `fffctl migrate`, a copy) | `vault.json` holds ciphertext; the key is never in `data/` or a backup |
| An orchestrator on the portal (the same OS user) goes for the key | The secret guard refuses reads of `vault.keyFile`, `/etc/fff`, `/run/credentials` and `$CREDENTIALS_DIRECTORY` (`portalSecretRules`), as it refuses `data/` and the token file, and the variable is removed from the agents' environment. This is a seatbelt, not a boundary: a shell command of the same user can still read the credential while the service runs. The boundary is the one D2 accepted |
| A value reaches a log, a transcript or chat | No route, tool or command returns one. Transcripts, the daemon log and the portal log redact Claude, GitHub, provider and Discord tokens by pattern, and every value the vault holds by value (`registerSecretValues`), whatever its form. Errors name entries, never values |
| Someone asks an agent in chat to add or print a token | There is no tool for it. Values enter through fffctl (root in the VM) or the owner's own browser session |
| FFBox | Nothing is shared: no FFBox secret is in the vault, and no vault value goes to FFBox |
| The FFBox host's root | Can read the VM's memory and disk (D2, accepted with mitigations). The vault keeps the values out of `config.json` and `data/`; it does not change that boundary |

**What reaches a worker machine:** the machine token on disk, and, for the life of each agent process, that run's
environment. Nothing else.

## 6. Migration

Each step can be undone on its own. The commands are in [Cut-over](#cut-over).

1. **Build the vault in the VM, after the portal's cut-over (w508).** The key is made in the VM; `vault.json` is in
   `data/`, so a later `fffctl migrate` or a restore carries it, and root carries the key (section 8). Do not fill a
   vault on BEAST's portal: its key would have to be carried across by hand.
2. **Enter the tokens** with `fffctl vault add` or the dialog: each person's Claude tokens with their owner and whether
   they are shared, the workers' GitHub token, Max's Discord token for the posting machine.
3. **Switch one machine at a time:** `set_app_config machines.claudeFromVault true machine: "<id>"`, m3 first, then
   m5, LothDesktop, BEAST. Its next agent process runs on a vault token; running ones keep theirs.
4. **Grant the other secrets** to that machine, then check that a worker there can `gh auth status` and push, and, on
   the posting machine, that `ffdiscord` posts.
5. **Retire the machine's own logins** only after it has run on the vault for a while with no fallback warning:
   `claude /logout`, `gh auth logout`, and LothDesktop's Discord token in `secrets.env`. Until then they are the
   fallback.

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
work is the risk, and the vault makes that an explicit choice per token (open decision 1).

## 8. Moving the portal (w508) and backups

- `vault.json` is in `data/`, so `fffctl migrate` and the daily backup carry it, as ciphertext.
- The key is in neither. Its spare copy is kept as root on the FFBox host (open decision 2), from where root puts it
  back into a rebuilt or new VM (cut-over step 3 shows both directions). Without it: `sudo fffctl vault init
  --new-key`, then rotate every entry (each lists as unopenable until then).

## 9. Follow-ups

- The orchestrators and the dispatcher on vault tokens (a `"vault"` value for `claudeAccounts`), retiring
  `claudeTokenFile`. The workers do not need it; it would put D4's token in the vault too.
- The meters attribute a stopped vault session by the current config rather than the token it ran on, as for every
  account (`sessionSource`); live sessions are exact.
- A dedicated OS user for the portal's own agents would make the key boundary real rather than a seatbelt (section 5).

## Open decisions

1. **Sharing across people** (lothsahn, and Ben for his own tokens). *Recommendation:* each person's token
   `share: owner`, and only the system payer's token shared, for work nobody asked for; share a token across people
   only if its owner accepts the terms risk in section 7, or move shared work to Team seats or API keys. *Rests on:*
   the Consumer Terms quote (sourced) and a guess on how it applies to a two-person team.
2. **Where the key's spare copy lives.** *Recommendation:* `/etc/fff-vm/secrets/vault.key` on the FFBox host (root
   only), beside the tokens w498's installer already keeps there for rebuilding the VM; never in the daily backup.
   *Rests on:* D2 (root on that host can read the VM anyway, so the boundary does not move; the VM doc).
3. **The workers' GitHub token's account** (w511 decision 4): Ben's or a bot account. The vault takes either.

## Cut-over

In order, by lothsahn (Ben for his own tokens). Nothing here runs until he says so. It assumes the portal already runs
in the VM (w508's cut-over) and this change is on `main`.

1. **The guest's scripts, then the portal's code.** On the FFBox host:
   ```bash
   cd ~/ff-factory && git pull && sudo deploy/vm/host/install.sh --guest-only
   sudo fff-vm ssh 'sudo fffctl update'
   sudo fff-vm ssh 'sudo fffctl status'                      # until the release is main's newest and /api/health answers
   ```
   The guest install puts in the new `fffctl` and `fff-portal.service` and makes `/etc/fff/vault.key`; the update
   builds the release with the vault and restarts the portal on it, which loads the key.
2. **Check the key.** `sudo fff-vm ssh 'sudo fffctl vault list'` prints `key: loaded (…)` and `no entries`.
3. **The key's spare copy** (decision 2), on the FFBox host, never printed:
   ```bash
   sudo sh -c 'umask 077; fff-vm ssh "sudo cat /etc/fff/vault.key" > /etc/fff-vm/secrets/vault.key'
   # Back into a rebuilt VM later:
   sudo sh -c 'fff-vm ssh "sudo install -m 0600 /dev/stdin /etc/fff/vault.key" < /etc/fff-vm/secrets/vault.key' && sudo fff-vm ssh 'sudo fffctl vault init'
   ```
4. **Each Claude account.** On a computer signed in to it, `claude setup-token`; put the token alone in a file
   (`chmod 600`), copy it into the VM (`sudo fff-vm ssh`, or `scp` to the admin user), then in the VM:
   ```bash
   sudo fffctl vault add --kind claude --name ben-max --owner ben --share owner --file /tmp/t && shred -u /tmp/t
   ```
   Repeat per account. Names are free text; `--owner` is a portal user id; add `--machines m3,m5` or
   `--roles workers` to narrow it (default: workers and standing, every machine). Or use Settings → Token vault.
5. **The workers' GitHub token:**
   `sudo fffctl vault add --kind github --name workers-gh --share anyone --file /tmp/gh && shred -u /tmp/gh`.
6. **Max's Discord token, for the posting machine only:**
   `sudo fffctl vault add --kind env --env FFDISCORD_APP_TOKEN --name max-discord --share anyone --machines lothdesktop --file /tmp/d && shred -u /tmp/d`.
7. **Check.** `sudo fffctl vault list` shows each entry's fingerprint and last four characters; so does Settings →
   Token vault. Within a minute the usage meters show a "vault: <name> …abcd" account per Claude entry.
8. **Switch the first machine** (yourself in `set_app_config`, or ask your orchestrator):
   `set_app_config machines.claudeFromVault true machine: "m3"`. Start a worker there: its brief says "vault token
   <name> …abcd", and `system_status` lists it under that account with no vault warning.
9. **Repeat step 8** for m5, lothdesktop and beast.
10. **After a few days with no fallback warning**, retire each machine's own logins (section 6, step 5).

**Rollback, any time:** `set_app_config machines.claudeFromVault false machine: "<id>"`, and
`sudo fffctl vault grant <name> --machines <the others>` to take a machine out of an entry. A machine to cut off
entirely: `sudo fffctl machine-credential revoke <id>`.

## Runbook

**Add a token:** step 4, 5 or 6 above (`fffctl vault add … --file FILE`), or Settings → Token vault → Add a token
(owners only). The value is never shown again.

**Rotate a token:** make the new one, then `sudo fffctl vault rotate <name> --file FILE` (or Rotate in the dialog).
Runs started from then get it; running ones keep the old one until their process restarts. Revoke the old token where
it was made.

**Change who gets it:** `sudo fffctl vault grant <name> [--machines m3,m5|*] [--roles workers,standing] [--owner ID]
[--share owner|anyone] [--enable|--disable]`.

**Remove a token:** `sudo fffctl vault remove <name>`, then revoke it where it was made.

**Enroll a machine** (a new one, or after a revoke):
1. In the VM: `sudo fffctl machine-credential issue <id> --out /tmp/<id>.cred`. It is written to that file (0600) and
   never printed; the credential before it, if any, stops connecting.
2. Move the file to the machine, into the daemon's `daemon.json` `token` field today (w511's `secrets/machine-token`
   once w513 lands), or let `add_machine` do the whole deploy, which issues its own. Delete the file in the VM.
3. The machine's daemon connects; `list_machines` shows it online. Grant it entries as above.

**Cut a machine off:** `sudo fffctl machine-credential revoke <id>` (or ✕ beside it in the dialog). Its link drops
within 20 s; its sandboxes and sessions stay for when it is enrolled again.
