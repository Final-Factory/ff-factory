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
| The workers' GitHub token (push, PRs, `gh`) | every worker | gh's login in each machine's keyring (BEAST: Windows Credential Manager, git's helper `gh auth git-credential`; measured in w511) | **Moves**: kind `github`, given as `GH_TOKEN`, plus a git credential helper that reads it (`githubCredentialEnv`). One fine-grained token per person (lothsahn, 2026-10-06; section 10) |
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
  the command line, where any process could read it. Root's writes are handed to the `fff` user.
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
| `github` | a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) | `GH_TOKEN`, and a git credential helper for `https://github.com` that reads it |
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
work is the risk; lothsahn decided each person's tokens serve only their own work (section 10).

## 8. Moving the portal (w508) and backups

- **The FFBox host is where the tokens live** (lothsahn, 2026-10-06; [section 11](#11-the-tokens-on-the-ffbox-host)).
  The VM's vault is filled from there by `fff-vm vault-sync`, so a rebuilt or moved VM gets them back from the host.
- **Not in the VM's daily backup:** `fff-backup` leaves `data/vault.json` out (`--exclude='data/vault.json*'`), and the
  key was never in it (`/etc/fff` is not under `/srv/fff`).
- **The key's spare copy** is `/etc/fff-vm/secrets/vault.key` on the host, kept in step with the VM's key by every
  `fff-vm vault-sync` (the one before kept as `.prev`). Entries added by hand in the VM (Max's Discord token, say) open
  again after a rebuild once root puts that copy back:
  `sudo sh -c 'fff-vm ssh "sudo install -m 0600 /dev/stdin /etc/fff/vault.key" < /etc/fff-vm/secrets/vault.key' && sudo fff-vm ssh 'sudo fffctl vault init'`.

## 9. Follow-ups

- The orchestrators and the dispatcher on vault tokens (a `"vault"` value for `claudeAccounts`), retiring
  `claudeTokenFile`. The workers do not need it; it would put D4's token in the vault too.
- The meters attribute a stopped vault session by the current config rather than the token it ran on, as for every
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
  people/<user id>/github-token          0600: one fine-grained GitHub token (github_pat_...)
  vault.key                              0600: the spare copy of the VM's vault key
```

**How the VM gets them: pushed in, not shared.** `sudo fff-vm vault-sync` (`deploy/vm/host/vault.sh`) sends each file
over ssh's stdin to `fffctl vault put` in the VM, as the installer already sends the Claude and GitHub tokens
(`push_secret`, `deploy/vm/host/guest.sh`). The entries are `host-<user>-claude` and `host-<user>-github`, `share:
owner`, for workers and standing agents on every machine. A second run changes nothing; a new value rotates its entry; a
removed file removes its entry. Entries not named `host-…` (added by hand) are left alone. The installer's guest step
runs it too, so a re-run or a rebuilt VM is filled again.

*Why not a read-only virtiofs share:* it needs a new device in the VM's libvirt definition and a cold restart of the
VM; while mounted, every file in it is readable from inside the VM by root and anything root runs, at any time, rather
than only the values the vault was given; and the vault would need a second reader for it. The push needs nothing new
on the host and reuses a path the installer already uses and CI already tests.

**Checks before a value goes in:** a Claude token must be one `sk-ant-oat01-…` token; a GitHub token must be
fine-grained (`github_pat_…`). A classic `ghp_` token is refused: lothsahn asked for fine-grained tokens, one per person,
scoped to the Final-Factory repositories.

## Decisions

1. **Sharing across people:** no. Each person's own tokens for their own work (lothsahn, 2026-10-06; section 10).
2. **Where the tokens and the key's spare copy live:** on the FFBox host under `/etc/fff-vm`, root only, not in the
   VM's daily backup (lothsahn, 2026-10-06; section 11).
3. **The workers' GitHub token:** one fine-grained token per person, scoped to the Final-Factory repositories
   (lothsahn, 2026-10-06), in place of w511's single workers' token.

## Cut-over

In order. Nothing here runs until lothsahn says so; each person puts in their own tokens, on the FFBox host, never
through chat. It assumes the portal runs in the VM (w508's cut-over) and this change is on `main`.

**1. The portal and the scripts** (lothsahn, on the FFBox host):

```bash
cd ~/ff-factory && git pull
sudo deploy/vm/host/install.sh --guest-only          # new fffctl, fff-portal.service, fff-backup; the VM's vault key; fff-vm vault-sync
sudo fff-vm ssh 'sudo fffctl update'
sudo fff-vm ssh 'sudo fffctl status'                 # until the release is main's newest and /api/health answers
sudo fff-vm ssh 'sudo fffctl vault list'             # "key: loaded"
```

**2. Each person's tokens** (each person makes their own; lothsahn or Ben puts them on the host as root):

- **Claude:** on any computer signed in to your claude.ai account, run `claude setup-token` and copy the token it
  prints.
- **GitHub:** github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new
  token:
  - Resource owner: **Final-Factory**; Repository access: **All repositories** (or select FinalFactory, ff-factory,
    final-factory-agents and the others workers push to);
  - Permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Workflows: Read and write** (to push
    a change under `.github/workflows`), **Actions: Read** (to read CI runs; Read and write if workers re-run them),
    Metadata: Read (automatic);
  - Expiration: up to a year; note the date. If the organization requires approval for fine-grained tokens, an owner
    approves it under the organization's Settings → Personal access tokens.
- **Put them on the host** (`<id>` is your portal user id: `lothsahn`, `ben`). Each command reads the token from the
  terminal without echoing it, so it is never on a command line, in shell history or in chat:

```bash
sudo install -d -m 0700 /etc/fff-vm/secrets/people/<id>
sudo sh -c 'umask 077; read -rs -p "Claude token: " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/<id>/claude-token'; echo
sudo sh -c 'umask 077; read -rs -p "GitHub token: " t && printf "%s\n" "$t" > /etc/fff-vm/secrets/people/<id>/github-token'; echo
sudo fff-vm vault-sync                               # "added host-<id>-claude", "added host-<id>-github"; values never shown
```

Ben is not on the FFBox host: lothsahn runs the same commands there, and Ben types his own tokens at the hidden prompts
(the two can share one ssh session to the host, for instance with `tmux`), or Ben hands the two values to lothsahn
through a channel that is not chat (in person, or a password manager's share).

**3. Check:** `sudo fff-vm ssh 'sudo fffctl vault list'` shows `host-lothsahn-claude`, `host-lothsahn-github`,
`host-ben-claude`, `host-ben-github`, each with its last four characters; within a minute the usage meters show
"vault: host-<id>-claude …abcd" accounts.

**4. Max's Discord token, for the posting machine only** (in the VM; unchanged):
`sudo fffctl vault add --kind env --env FFDISCORD_APP_TOKEN --name max-discord --share anyone --machines lothdesktop --file /tmp/d && shred -u /tmp/d`.

**5. Switch one machine at a time** (lothsahn, in `set_app_config` or through his orchestrator):
`set_app_config machines.claudeFromVault true machine: "m3"`, then m5, lothdesktop and beast. A worker started there
for lothsahn's request says "vault token host-lothsahn-claude …abcd" in its brief, and `gh auth status` there shows his
token; one for Ben's request shows Ben's.

**6. After a few days with no fallback warning in `system_status`**, retire each machine's own logins (section 6, step
5).

**Rotating a token later:** replace its file (step 2), then `sudo fff-vm vault-sync`. **Removing a person's:** delete
their files, then `sudo fff-vm vault-sync`; revoke the tokens where they were made.

**Rollback, any time:** `set_app_config machines.claudeFromVault false machine: "<id>"`. A machine to cut off
entirely: `sudo fff-vm ssh 'sudo fffctl machine-credential revoke <id>'`.

## Runbook

**Add, rotate or remove a person's tokens:** the files under `/etc/fff-vm/secrets/people/<id>/`, then
`sudo fff-vm vault-sync` (Cut-over, step 2).

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
