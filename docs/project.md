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
