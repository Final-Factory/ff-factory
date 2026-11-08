# The project seam: one core, a portal per job

FF Factory was built for Final Factory, and its agents' briefs say so. Config `project` (server/config.ts,
`ProjectConfig`) lets a portal run another job on the same core: a legal case room, a SketchUp studio, an audiology
front office. Leave it unset and every brief is Final Factory's, byte for byte (server/project.test.ts).

```json
"project": {
  "name": "Ken Martin Audiology",
  "description": "a three-person audiology practice's front office",
  "unity": false,
  "community": false,
  "integration": "local",
  "worldBriefFile": "/srv/pack/world-brief.md",
  "orchestratorBriefFile": "/srv/pack/orchestrator-brief.md",
  "workerBriefFile": "/srv/pack/worker-brief.md",
  "heading": "What should the office work on?",
  "suggestions": ["Check benefits for tomorrow's appointments", "Send this week's recall messages"]
}
```

| Key | Default | What it changes |
|---|---|---|
| `name`, `description` | Final Factory, "a Unity 6 DOTS space automation game …" | The first line of the dispatcher's and each personal orchestrator's brief, and "an isolated sandbox of the `<name>` repo" in the worker's. A name other than Final Factory also names the portal page: the sidebar, in place of the host name, and the tab title. |
| `unity` | true | false drops the worker brief's "Unity" section. |
| `community` | true | false drops the worker brief's Discord rules (FFBox, Max, #bug-reports) and the page's Max and FFBox strip. |
| `heading`, `suggestions` | "What should the factory work on?", Final Factory's chips | The orchestrator page's empty state: its heading and up to 6 suggestion chips. |
| `integration` | `pull-request` | `local`: no pull requests and no CI. Drops "Waiting on CI" and "Your pull requests", and the Git section tells the worker to commit and land work as "This deployment" says (for example: a person approves a proposal on a card, then the worker merges to main). |
| `worldBriefFile` | none | Replaces the orchestrators' "what there is" list (sandboxes, machines, standing agents, FFBox, Max, the intake) with the job's own; the "Your tools" line stays. |
| `orchestratorBriefFile` | none | Appended to both orchestrators' briefs as "## This deployment". |
| `workerBriefFile` | none | Appended to every worker's brief as "## This deployment", before "Reporting". |

Brief paths resolve against the app folder (absolute paths are fine). A file that cannot be read is logged once and
leaves its brief as it was.

What it does not do yet: the shared rule blocks (processes, disk, shell steps, evidence) still speak of the game in
places ("a game player left running", "a Steam branch"), and `read_rules` topics are Final Factory's. A job's
`workerBriefFile` says which of those do not apply. Splitting those blocks into a Final Factory pack is the next step
(report r76, "Build plan").

## A second portal on machines that already run one (w3714)

What standing up Ben's Light Tree portal on BEAST, m5, m3 and biscuit beside the live one took (2026-11-08, measured):

- **Its own everything.** Its own port, `dataDir`, base clone, vault key, scheduled tasks or LaunchAgents with their own
  names, and a daemon per machine with its own `root`, token file and `CLAUDE_CONFIG_DIR`. The full worker installer
  (`scripts/worker/install.sh`) refuses a machine that already has a daemon, so the second daemon is a plain
  `node machine/daemon.ts <daemon.json>` of a pinned commit.
- **Make the machine record before the daemon dials.** The portal admits a daemon only for a machine it has a record
  of; without one each dial is a failed login, and after 10 the address is locked out for 15 minutes (HTTP 429). Make
  the records first with `POST /api/machines/join` (owners only), which also gives a code a machine on the tailnet can
  redeem itself at `POST /machine/join`.
- **Clone the project repo at each daemon's `repoPath`.** The installer clones it; a hand-made daemon must too. Without
  it `git check-ref-format` fails in a missing folder and `create_sandbox` refuses every branch name as "not a valid
  branch name", which reads like a portal bug. Later fetches use the vault's GitHub token.
- **macOS with nobody logged in at the screen** has no `gui/<uid>` launchd domain (bootstrap error 125): bootstrap into
  `user/<uid>` with `LimitLoadToSessionType` `Background` (keep `Aqua` too), and wait for a `bootout` to finish before
  the next `bootstrap` (error 5 otherwise).
- **Each daemon's leftovers sweep spares the other's workers** by their `FF_WORKER_ROOT` (`sameRoot`,
  machine/leftovers.ts): both daemons on a computer have the same machine id, so before this the live BEAST and m3
  daemons ended the Light Tree workers' `claude` every few minutes ("exited with code 1"). Give the second daemon its own
  `root`.
- **A repository outside the Final-Factory organization** is not probed for the organization's runners and artifacts
  (`inGithubOrg`, server/githubTokens.ts), and a repository with no pull request yet is "not measured" rather than a CI
  read fault (`ciUnmeasured`, server/ciReadHealth.ts), so a new instance's dashboard opens without false banners once config `vault.githubRepos` names its own
  repositories (`["bryding/light-tree"]`); left unset it falls back to Final Factory's (`GITHUB_REQUIRED_REPOS`,
  server/index.ts), and the token reads as lacking the organization's Self-hosted runners.
