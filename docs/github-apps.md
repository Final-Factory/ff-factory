# GitHub Apps: reaching another account's private repositories (w1519)

A person's vault GitHub token (docs/vault.md section 13) is fine-grained, and a fine-grained token reaches only the
repositories of its resource owner (Final-Factory). A modder's private repositories, such as Gherik1/ItemCannon and
Gherik1/PlayerUpgrades, are reached through a **GitHub App**: the owner of the repositories installs it on just those
repositories, and FF Factory uses the app's installation tokens for them. Those tokens last one hour and reach only the
repositories the installer picked. Nobody hands FF Factory a token with their full rights.

lothsahn (w1519): "I'd like you to add support for this and let me know what i need to do to make an app that Gherik can
add".

## How it works

- **The vault** keeps the app as an entry of kind `github-app`. Its value is the app's private key (the `.pem` file), sealed like
  a token and never shown. Beside it, in the clear: the App ID and the **allowlist** (`appOwners`), the GitHub accounts
  whose installations are used. The key never leaves the portal: machines get only installation tokens.
- **Tokens** (`server/githubApps.ts`): the portal signs a JWT with the key (RS256, at most 10 minutes), lists the app's
  installations (`GET /app/installations`), and mints a token for each allowed installation
  (`POST /app/installations/{id}/access_tokens`) along with the list of repositories it covers
  (`GET /installation/repositories`). Each token is replaced 15 minutes before its hour is up. The installations are read
  again every hour, and at once with **Re-check now** (Settings, Token vault).
- **Routing per repository.** A repository an allowed installation covers gets the app's token. Every other repository
  keeps the person's own token, exactly as before. That covers:
  - the portal's own `gh` calls, for example a PR state that `blocked_on` waits for (`server/githubTokens.ts` runner);
  - a worker's `git` on the machines. The run's git credential helper for `https://github.com` is the daemon's
    (`machine/ghApp.ts`), with `credential.useHttpPath`, so git tells it the repository: `Gherik1/ItemCannon.git` gets the
    app token, anything else the run's `GH_TOKEN`;
  - a worker's `gh`. A `gh` shim first on the run's PATH works out the repository (`-R`, a github.com URL,
    `gh api repos/…`, `gh repo clone owner/name`, else the folder's remotes: upstream, github, origin) and runs the real gh
    with `GH_TOKEN` set to the app token for such a repository. `ff-pr` does the same itself.

  It works the same on Windows (Git Bash and PowerShell), macOS and Linux workers.
- **Whose work.** Nothing changes for the pool or the accounting. A run in Gherik1's repositories is still the requesting
  person's run, on their Claude pool, and the ledger counts it for them. Only the GitHub credential for those repositories
  differs. On GitHub, pushes and PRs made with the app token show as the app (`<slug>[bot]`); the commits keep the author
  git was given.
- **Which runs get it.** The entry's grants decide, like any vault entry: roles, machines, and `share` (its owner's work
  only, or anyone's). The app is used only on machines where `machines.githubFromVault` is on, and only by runs that also
  got a vault GitHub token: the routing helper replaces the machine's own git helpers, so a run on the machine's own gh
  login keeps that login and gets no app.
- **Fallback.** A repository the app is not installed on, an installation off the allowlist, a suspended installation or a
  refused key all mean the person's own token is used, as before, and the health line says why. When GitHub refuses an app
  token on a portal call, the call is made again on the person's token and the app's token is minted again at the next tick.

## Who may install it (the allowlist)

The app must be **public** ("Any account"), or Gherik cannot install it. GitHub's docs: a private app "can only be
installed on the account that owns the app". A public app is not listed anywhere (the Marketplace is a separate opt-in),
but anyone who finds its page can install it on their own account.

An installation only gives FF Factory access to the installer's repositories. It never gives the installer access to
anything of ours. FF Factory uses only installations on the accounts in the entry's `appOwners` (and, optionally, only the
installation ids in `installations`). Any other installation is ignored and listed on the health line as "ignored, not on
the allowlist".

**Uninstalling the others** (`--uninstall-others`, off by default) removes the app from any account off the allowlist,
through `DELETE /app/installations/{id}` (JWT only), with a log line and a notice. It is safe for the allowlist: an account on
it is never uninstalled, and an app entry cannot exist without one. It is still off by default. An ignored installation does
no harm, uninstalling is visible to that account, and a typo in the allowlist would remove Gherik's own installation (he
would have to install again). Turn it on only if strangers start installing the app.

## What lothsahn clicks: creating the app

Recommended owner: **the Final-Factory organization**, not a personal account. Another owner of the organization (Ben) can
then manage it and make a new key, and it does not depend on one person's account. Either works for Gherik.

1. github.com → your picture (top right) → **Your organizations** → **Settings** beside **Final-Factory**.
   (For a personal app instead: your picture → **Settings**.)
2. Left sidebar, at the bottom: **Developer settings** → **GitHub Apps** → **New GitHub App**.
3. **GitHub App name**: a unique name of 34 characters or fewer, for example `Final Factory Mods`. Its slug (the URL name,
   for example `final-factory-mods`) is what Gherik sees.
4. **Description**: for example "Final Factory's agents work on mod repositories you select."
5. **Homepage URL**: `https://github.com/Final-Factory`.
6. **Identifying and authorizing users**: leave **Callback URL** empty. Leave **Request user authorization (OAuth) during
   installation** and **Enable Device Flow** unticked. FF Factory uses no user tokens.
7. **Post installation**: leave **Setup URL** empty.
8. **Webhook**: **untick Active**. FF Factory reads the installations itself (hourly, and with Re-check now), so it needs no
   webhook, no public endpoint and no webhook secret.
9. **Permissions** → **Repository permissions**. Set these, and leave everything else at **No access**:

   | Permission | Access | Why |
   |---|---|---|
   | Actions | Read-only | read CI runs (`gh run list`, ff-pr merging on green) |
   | Checks | Read-only | read check results (`gh pr checks`) |
   | Contents | Read and write | clone, fetch and push branches; merge a pull request |
   | Metadata | Read-only | given to every app (mandatory) |
   | Pull requests | Read and write | open, comment on and merge pull requests |
   | Workflows | Read and write (optional) | only to push changes to `.github/workflows` files |

   Pick **Workflows** only if the mods have GitHub Actions workflows that workers must change. Without it, a push that
   touches `.github/workflows` is refused, and everything else works. **Organization permissions** and **Account
   permissions**: none. **Subscribe to events**: none (it is greyed out with the webhook off).
   The check `server/githubApps.test.ts` keeps this table equal to `GITHUB_APP_PERMISSIONS` in
   `shared/githubRequirements.ts`, which the health check uses.
10. **Where can this GitHub App be installed?** → **Any account**.
11. **Create GitHub App**.
12. On the app's **General** page: note the **App ID** (a number, near the top).
13. Same page, **Private keys** (at the bottom) → **Generate a private key**. The browser downloads
    `<slug>.<date>.private-key.pem`. That file is the key: keep it off chat, email and the repository.
14. Send Gherik the public page: `https://github.com/apps/<slug>` (the **Public link** on the General page).

## What Gherik clicks: installing it on two repositories

1. Open `https://github.com/apps/<slug>` → **Install** (or **Configure**, if it was installed before).
2. Pick the account **Gherik1**.
3. **Only select repositories** → select **ItemCannon** and **PlayerUpgrades**. (Not "All repositories".)
4. Check the permissions shown, then click **Install**.

Later changes, from the same account: github.com → picture → **Settings** → **Applications** → **Installed GitHub Apps**
→ the app → **Configure**. There he adds or removes repositories, suspends it, or uninstalls it. When lothsahn later asks
for more permissions, the app's change waits there until Gherik accepts it (**Review request**). GitHub's docs: the owner
of each installation "will be prompted to approve the new permissions". Until then the health line names what is not
accepted yet.

## Putting the app in the vault (lothsahn, in the portal)

Nobody runs a command or copies the key anywhere: the portal's vault page takes the `.pem` file from the browser. The vault
page is an owner's only.

1. In the portal, open the sidebar → **Settings** → the **Token vault** section → **Add a token or GitHub App**.
2. **name**: `app-gherik`. The name may not start with `vault-` or `host-`: the FFBox host's `fff-vm vault-sync` removes
   entries with those names that it has no file for (docs/vault.md section 12), so the vault refuses such a name for an app.
3. **kind**: **GitHub App (private key)**. The App ID, accounts and uninstall fields appear.
4. **owner**: lothsahn. **share**: **any run** lets anyone's work in Gherik's repositories use it (the app reaches only the
   repositories Gherik picked); **the owner's own work only** keeps it to lothsahn's requests.
5. **roles** and **machines**: leave `workers, standing` and `*`, or list machines (`m3, lothdesktop`).
6. **App ID**: the number from the app's General page (step 12 above).
7. **accounts whose installations are used**: `Gherik1`. Leave **uninstall it from other accounts** unticked (the allowlist,
   above).
8. **Choose the .pem file** → the file the browser downloaded in step 13 (`<slug>.<date>.private-key.pem`). The button then
   reads "… loaded". Pasting the file's whole text into the field beside it works too: line breaks lost in the paste do not
   matter.
9. **Add**. The entry shows the key's last four characters, never the key. A refusal (not a key, no App ID, a `vault-`
   name) shows its reason and leaves the form as it was.
10. Delete the downloaded `.pem` file from your computer: the vault keeps the only copy needed, and GitHub makes a new key at
    any time.

Within a minute the entry's line on the vault page shows the app read: **key valid** and **Gherik1 (installation N): 2
repositories** (Health, below). **Re-check now** at the bottom of the GitHub section reads it again at once.

Later changes, on the same page:

- **Grant** on the entry: the App ID, the accounts, uninstall-others, machines and roles. The key is untouched, and a
  changed allowlist is read again at once (an account taken off loses its token on the next read, not an hour later).
- **Rotate** → **Choose the .pem file** with a new key (Generate a private key again on the app's page), **Save**, then
  delete the old key on the app's page.
- **Disable** or **Remove**: no run gets the app's tokens from then on.

On the VM, `sudo fffctl vault add --name app-gherik --kind github-app --app-id <App ID> --app-owners Gherik1 --owner
lothsahn --share anyone --file <the .pem>` does the same (`grant` takes `--app-id`, `--app-owners`, `--installations`,
`--uninstall-others`, `--keep-others`; `rotate app-gherik --file new.pem`), for whoever already works there. Pinning
installation ids (`--installations`) is the one setting only the command line has; it is never needed for Gherik's case.

The key is not copied to the FFBox host at night (`export --manifest` leaves apps out): GitHub makes a new key at any
time, so a lost VM is fixed with a new key, not a restored one.

## Health

- **system_status** has one line per app, for example: `GitHub App app-gherik …abcd (lothsahn's), App ID 123456,
  final-factory-mods owned by Final-Factory; key valid; Gherik1 (installation 11): 2 repositories (gherik1/itemcannon,
  gherik1/playerupgrades); grants Actions read, Checks read, Contents write, Metadata read, Pull requests write; token until
  04:00Z; ignored, not on the allowlist: stranger (installation 99); read 03:00Z; last used …`.
- **The banner** (the GitHub token banner's kind) appears when an app lacks something, worded the way a token's is: a key
  GitHub refuses (a wrong App ID, or a deleted key), not installed on an allowed account (with the install link), an
  installation suspended or covering no repository, or a required permission that is missing. A missing permission is
  worded by its cause: "is not asked for" (set it on the app's page) or "not accepted yet" (Gherik accepts it). A missing
  Workflows is never a problem.
- **The vault page** shows the same under the entry.

Nothing logs or shows the key or a token: the key's last four characters (of its base64 body), installation ids and
account names only. Each new token is added to redaction (`server/secrets.ts`) before any process gets it.

## Rollout

1. Merge this change, then a **portal deploy** (the portal mints and routes).
2. **Update the machines' daemons** where workers should reach the app's repositories. A daemon from before this change
   ignores the tokens: its runs keep the person's token for every repository, which fails there.
3. lothsahn creates the app, Gherik installs it, lothsahn adds it on the portal's vault page (above).
4. `machines.githubFromVault` must be on for those machines (it already is where vault GitHub tokens are used), and on for
   `"portal"` for the portal's own reads. An orchestrator sets it (`set_app_config`), no person.
5. The vault page and system_status show the app's line: key valid, Gherik1's installation with both repositories, no
   WARNING.
