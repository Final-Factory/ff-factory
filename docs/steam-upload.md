# Steam uploads: the daemon holds the build account (w5551)

Item 13 of the w5451 security audit (lothsahn): "No worker holds the Steam password; the daemon uploads only its own release's
build". Before this, the urgent release lane (the game repo's `cicd/urgent_release.py`, `Documentation/Release-Lanes.md`) ran
FFBox's `ffsteam.py` inside the worker: the vault gave every worker on BEAST and LothDesktop `FFSTEAM_PASSWORD` (role
`workers`), and steamcmd with its cached login lived in `<root>/steam`, which workers could write. Any worker could upload any
folder to any Steam branch, default included.

## What changed

- **No run gets the credential.** `DAEMON_ONLY_ENV` (`server/vault.ts`): `FFSTEAM_PASSWORD`, `FFSTEAM_GUARD_SECRET` and
  `FFSTEAM_GUARD_CODE` are skipped by `forRun` whatever their entry's roles. `releaseSecrets(machineId)` reads them for the
  daemon's job alone, from entries of the new role `releases` (or still `workers`, so the existing entry keeps working).
  Test: `server/vault.test.ts`, "the Steam build account reaches no run".
- **`<root>/steam` is the daemon's.** It is no worker child on Windows (`machine/lowIntegrity.ts` `WORKER_CHILDREN`), so the
  next rollout relabels it Medium where it was Low and a Low worker cannot write it; Landlock (`machine/writeLock.ts`
  `LOCKED_CHILDREN`) and Seatbelt (`server/workerFence.ts` `READ_ONLY_IN_ROOT`) keep it read-only (`DAEMON_ONLY_CHILDREN`,
  `server/claudeHome.ts`). Reads are closed by the read-deny fence of w5546 once it lists `steam`.
- **`steam_upload`**, a worker tool (group ffbox), is the only way a release reaches Steam from a worker computer:
  - `action: "check"`: the daemon runs `ffsteam.py check`: whether the account logs in, and each app's depots (a `linux`
    depot means `runs` needs linux). At most once every 10 minutes a computer, unless `guard_code` is given.
  - `action: "upload"`: `version`, `app` (main or demo), `sha` (the bump commit built), `runs` (each platform's run folder),
    `live`, `preview`.
  - `action: "status"`: the job by `job` id.

## Who may upload what

The portal decides (`server/steamUpload.ts` `refuseUpload`, called from `Agents.steamUploadTool`), from facts it reads
itself, never from the caller's word:

| Check | Where it is read | Refusal |
|---|---|---|
| The caller builds a release here | `BuildPlans.building(machine, session)`: a started plan whose builder is this session | "you are not building a release on ..." |
| The build is the caller's own release | `cicd/release-lane.json` at `sha` (GitHub contents API): lane `urgent`, this `version`, this machine, and a request among the caller's open ones | "... another release's build", "... not one of your requests" |
| The commit is a merged bump | compare API: `sha` is behind or at master or pre-1.0 | "not on master or pre-1.0" |
| The live branch is the release's | `liveBranchesFor`: `development` for a master main release; nothing for pre-1.0 or the demo | "sets development live, not ...", "sets no Steam branch live" |
| Once per version and app | the daemon's `<root>/steam/uploads.json` | "uploaded already" |

A preview (`--preview`: manifests only, nothing uploaded, nothing set live) skips the build, claim and branch checks and may
not name `live`. Tests: `server/steamUpload.test.ts` ("refuses another request's build", "refuses a Steam branch the release did
not name").

The daemon checks again (`machine/steamUpload.ts` `runSteamJob`): each run folder must resolve inside the caller's sandbox or
temp folder; it copies the players without links into `<root>/steam/staging/`, runs FFBox's `ffrelease-check.py` on the copy,
then `ffsteam.py upload` on the copy with only the job's secrets in its environment (no GitHub or Claude tokens), refuses any
live branch but `development`, never a live branch with a preview, and one Steam job at a time a computer
(`<root>/steam/job.lock`). FFBox's scripts come from its own clone in `<root>/steam/ffbox`, which workers cannot write.

Setting `default` or any other branch live stays a person's act on the Steam partner site: no agent path does it.

## FFBox

FFBox's own release lane is unchanged: its Steam credential is in its host's `secrets.env`, outside every worker computer.

## Vault

The entry `FFSTEAM_PASSWORD` may move from role `workers` to `releases` (a person's act in the vault); until then it still
reaches only the daemon's job, never a run.
