- **No worker holds the Steam build account; the daemon uploads a release's build through `steam_upload`** (w5551, item 13 of
  the w5451 audit). `FFSTEAM_PASSWORD` and the Guard variables reach no run (`DAEMON_ONLY_ENV`); the portal reads them only for
  the daemon's job. `<root>/steam` (steamcmd and its cached login) is no longer a worker folder: Medium on Windows, read-only
  under Landlock and Seatbelt. The new worker tool `steam_upload` checks the login (`check`) and uploads (`upload`) only the
  build of the caller's own urgent release (its started build plan, and the bump's `cicd/release-lane.json` naming this
  version, this computer and one of its requests), only from master or pre-1.0, live only on `development` for a master main
  release, once per version and app; `preview` runs steamcmd's `--preview`. The daemon copies the players without links,
  checks them with FFBox's `ffrelease-check.py` and runs `ffsteam.py`. docs/steam-upload.md. Needs a portal deploy and daemon
  updates.
