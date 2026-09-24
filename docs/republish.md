# Republishing this repo as open source

The app's repo began private, and its history holds machine names, paths and personal details that
were cleaned up later. So it is published with a fresh history: one squashed commit of the cleaned
tree, while the full history stays in a private `<name>-private` repo.

`scripts/republish-public.ps1` does it end to end. The orchestrator's `republish_public` tool starts
it outside the server (`launchIndependent`), because its last step restarts the app. Run it with
`dry_run` first: the preflight changes nothing on GitHub.

| Step | Done when | What it does |
|---|---|---|
| preflight | always | bare clone of the private repo in `data/republish/`; its `main` must have more than one commit; finds among the private repo's `public-main*` branches (listed with `ls-remote`: local-only branches do not count) or builds a single root commit with `main`'s tree (a real run pushes it as a new `public-main*` branch; a dry run keeps nothing), authored "Final Factory" with the GitHub noreply address; gitleaks on that commit and tree; a scan of the tree for this machine's own names (user, host, git name and email, `publicUrl` host, tailnet name, non-default ssh key file names) |
| supervisor | real runs | a real run refuses before anything irreversible when no supervisor runs (the last step needs one) |
| rename | `<name>-private` exists | `gh repo rename <name>-private -R <owner>/<name>` |
| create | `<owner>/<name>` is public | `gh repo create <owner>/<name> --public` (this also ends GitHub's redirect to the renamed repo) |
| push | the public `main` contains the commit | pushes the commit as `main`; a `main` with anything else stops the run |
| settings | always (idempotent) | private vulnerability reporting on (a failure is reported, not fatal) |
| move | `HEAD` contains the commit | `data/restart.request` with `update: true`: workers drain, the supervisor runs `update-steps.ps1`, which sees an unrelated upstream and resets to it (old `HEAD` kept on `pre-republish-<time>`, ignored files untouched), and the app restarts |
| verify | — | `HEAD` contains the commit and a `pre-republish-*` branch exists |
| report | — | a `[republish]` message to the orchestrator through `data/orchestrator-inbox` |

Every step is checked before it runs, so calling the tool again resumes after a failure. The script
never deletes a repo, a branch or a file on GitHub, and never force-pushes. Progress is in
`data/supervisor.log` (lines starting `republish:`). After it finishes, redeploy each machine
(`add_machine` with its id): the Macs run code copied from this host, not from GitHub.

`server/republish.test.ts` runs the script's dry run and its real path end to end against a fake
GitHub (bare repos through `url.insteadOf`, a fake `gh` first on PATH), playing the supervisor with the
real `update-steps.ps1`: publish, move the checkout, then a rerun that finds everything done. The first
real run broke on a path the dry run had never taken; this test keeps both paths exercised.
