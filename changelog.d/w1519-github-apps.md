- **GitHub Apps reach another account's private repositories** (w1519, lothsahn: "I'd like you to add support for this and
  let me know what i need to do to make an app that Gherik can add"). A new vault kind, `github-app`, holds an app's private
  key, its App ID and the allowlist of accounts whose installations are used (`--app-owners Gherik1`; any other
  installation is ignored, or uninstalled with `--uninstall-others`). The portal signs the app's JWT, mints each allowed
  installation's one-hour token and replaces it 15 minutes before its end. A repository such an installation covers gets that
  token: the portal's gh calls, and a worker's git (a credential helper that sees the repository, `credential.useHttpPath`)
  and gh (a shim first on PATH) on every machine. Every other repository keeps the person's own token. system_status, the
  banner and the vault page show the key, the installations, their repositories and grants, and what is missing. The
  daemons get the tokens in a new `gh_app_tokens` message (protocol 9, no bump: sent only to a daemon that offers `ghApp`).
  The app goes into the vault on the portal's vault page (Settings, Token vault, Add a token or GitHub App: the App ID,
  the accounts, and the `.pem` file chosen in the browser), and Grant there changes its allowlist without the key, read
  again at once. A refused add or rotate now leaves the form as it was. Needs a portal deploy and a daemon update. Steps
  for the app's owner, the installer and the vault:
  [docs/github-apps.md](../docs/github-apps.md). Tests: `server/githubApps.test.ts`.
