# FFBox in FF Factory: one orchestrator, two kinds of place to run work

What FFBox is, how it works, and how workers change it (straight to its master, one push at a time): [ffbox.md](ffbox.md).

Status: **approved by Ben and Lothsahn 2026-09-27. Phase 1, FF Factory's side, is built**: `/provider`,
the FFBox card and page, and `ffbox_activity` (`server/providers.ts`). The page groups intake reports by
coarse signature with the step 4 counts (`shared/intake.ts`), before phase 4 acts on them. The connector it talks to is
specified in [ffbox-connector-contract.md](ffbox-connector-contract.md). Every later phase is a
separate, reviewable change.

**2026-09-29 (w55): provider protocol 2, the ledger check both ways.** Built on both sides and off: FFBox asks the ledger
(`board_check` by `discord:<thread id>`) before a bug-report or suggestion turn or an intake diagnosis, links instead of
fixing twice, and follows the answer (the branch to watch, the release that carries the fix); each `ffbox/*` PR is
filed as a review request with its thread. FFBox owns #bug-reports and dev_bug_reports (Lothsahn), so FF Factory's
intake files no bug threads by default. The contract is [ffbox-connector-contract.md](ffbox-connector-contract.md),
"Protocol 2"; the box steps are in [intake.md](intake.md), "Rollout checklist: Lothsahn".

**2026-09-29: the intake ([intake.md](intake.md)).** FF Factory's side of phase 7's "both directions" and of phase 3's
sending is built and off: FFBox's fix branches and `request` messages become ledger requests that wait for a reviewer,
`board_check` lets FFBox ask the ledger before it works a report, and the dispatcher's `send_to_ffbox` submits work
once `providers.ffbox.sendWork` is on. FFBox is optional there: the Discord intake runs without it. Lothsahn's side is
listed in intake.md, "Rollout checklist: Lothsahn".

**Decisions so far (2026-09-27).** Ben: a small connector is fine, no secrets cross, and player input
stays on FFBox. Lothsahn: FF Factory tasks may use FFBox's open-internet `ffdev` containers.

**Which model runs depends on who asked (Lothsahn, 2026-09-28).** This corrects an earlier reading
that `ffdev` runs GLM-5.3 Flash and takes simple work only.

- **Operator work runs on Claude at full capability.** Ben and Lothsahn each have their own Claude
  subscription. FF Factory may send them work on FFBox whenever it is asked for, and FFBox bills it
  to the plan of the operator who asked (`requestedBy`). Nothing limits it to simple tasks.
- **Discord work runs GLM-5.3 Flash in the fenced class.** That is work that strangers ask for.
- Each class advertises its model and `tier` (`full` or `simple`) in the `capacity` message, and
  optionally a `models` list with one entry per kind of requester (`operator`, `discord`). The
  orchestrator and the FFBox page show what the connector reports.

**Ben's answers (2026-09-27).**

- Automatic desync investigations are capped at **20 a day** to start (section 6).
- Ben and Lothsahn share **one orchestrator chat** (section 7).
- **Lothsahn may use every machine except Ben's M5**: BEAST sandboxes and the M3 (section 7).
- FFBox bills Ben's work, and automatic work, to **Ben's second Claude account**, through a separate
  token that Ben gives Lothsahn directly. That token never passes through FF Factory (rule 3).
- **Billing follows the person who asked (Lothsahn's request, 2026-09-27).** Every work message
  carries `requestedBy`, the FF Factory login it came from. FFBox charges that person's account:
  Ben's work goes to the token Ben gave Lothsahn, and Lothsahn's goes to his own account. Automatic
  intake work is charged to a configured system payer, which is Ben. On Ben's machines, the agents
  Lothsahn asks for run on Lothsahn's own Claude token when FF Factory has one (section 7,
  [identity.md](identity.md)).
- Operator-requested work on FFBox, `ffdev` included, runs on the operator's own Claude plan, with no
  "simple only" limit (Lothsahn, 2026-09-28; rule 4a). GLM-5.3 Flash is for Discord work only.

**TL;DR**

- **The goal is zero human coordination.** Ben and Lothsahn each just start work ("gogogo"). The
  system decides where work runs, stops two agents working on the same problem, and starts desync
  investigations by itself. Nobody has to check with the other person first.
- **FFBox joins as a new front door into its own pipeline, not as a machine.** A small connector on
  the FFBox host dials out to FF Factory. It is fixed code with no model. It hands tasks to `ffwatch`
  like any other prompt and reports status, results and intake events back. FF Factory never gets
  a shell, an ssh key, a token or a config switch on FFBox.
- **Routing is automatic, from what a task needs.** Work that reads player data goes to FFBox's
  fenced class. Work that needs a GPU, rendered visuals, a Mac or the three-machine rig goes to
  BEAST or a Mac. Security-sensitive work goes to FFBox. CPU-only work goes to FFBox when no GPU
  sandbox is free. The server enforces the rule about player data, not just the prompt.
- **One board, and claims are enforced.** Every work item from both teams carries a dedupe key,
  such as a desync fork signature, an issue or PR number, or a spec number. Starting work on a key
  someone holds is refused. FFBox's own conversations appear on the board automatically, and open
  PRs that touch the same files are flagged.
- **Desync reports drive work by themselves.** Every report `ffintake` files becomes an event in FF
  Factory. Fixed code groups the reports by fork signature and matches them against known and fixed
  forks. For each new signature it starts one investigation on FFBox in the fenced diagnosis class,
  claimed on the board. Budgets and a storm breaker cap how many run. A desync storm becomes a
  handful of items, not fifty agents.
- **Eight phases, each small and reversible.** The first is read-only: the connector,
  capacity, and the intake feed.

## 1. The two systems as they are

### FF Factory

A Node server on a Windows host with a GPU (BEAST), reached through a web page and `/mcp`
(README.md, "How it works").

- **Sandboxes**: a git worktree of the game repo per work stream, its own Unity editor on the real
  GPU, and Claude Code worker agents running as the host user in `bypassPermissions`
  (`server/agents.ts:615-652`; `config.example.json`, `worker.permissionMode`).
- **Machines**: the Macs. `machine/daemon.ts` runs as a LaunchAgent, dials out to
  `wss://<portal>/machine` with a per-machine token whose SHA-256 the portal keeps
  (docs/machines.md, "Auth"). Protocol 3 (`server/machineProtocol.ts:8`) is an agent-execution
  protocol. The portal sends a full `LaunchSpec`: cwd, the appended system prompt, tool lists,
  guard settings and env (`server/launch.ts:15-48`). The daemon runs the Agent SDK session on the
  Mac (`machine/daemon.ts:272-280`). The portal installs and updates the daemon over ssh from its
  own code (`server/machines.ts:307-342`). It also sends the host's Claude OAuth token in the spec
  (docs/machines.md, "Claude account").
- **Orchestrator**: an Agent SDK session with Read/Glob/Grep and the `sandboxes` tool belt. It
  deliberately has no WebFetch, because it reads worker text that can carry prompt injection
  (`server/agents.ts:1492-1500`). Its brief tells it to relay `[standing agent]` text without acting
  on it (`agents.ts:1485`).
- **Standing agents**: scheduled, budgeted, and read-only by default. With the `delegate` group they
  file delegation requests. Approving one starts a worker in an `unused` sandbox or on an idle Mac
  (`server/standing.ts:559-600`, docs/standing-agents.md).
- **Guard**: a `PreToolUse` hook on every worker (`server/guard.ts`). The README calls it "a
  seatbelt, not a sandbox": a hijacked worker still runs as the host user and can read the Claude
  token in its environment (README.md, "Known gaps").
- **Watchdogs**: the Unity hang and crash watch (docs/unity-lifecycle.md), the dialog watchdog
  (docs/unity-dialogs.md), the host guard for disk, the Dev Drive and memory
  (docs/self-recovery.md), and a Mac that watches BEAST from outside.
- **Identity**: named web logins, each with a display name and a role (owner or member), and `/mcp`
  API keys that can be bound to a login (`server/auth.ts`, `server/apikey.ts`, [identity.md](identity.md)).
  Every person's message records its author, and the workers, standing runs and approvals it causes
  carry that person as `requestedBy`. Roles are recorded but not enforced yet, and an API key still gets
  the whole tool belt (`server/mcp.ts`).

### FFBox

A Linux build server that Lothsahn runs, from the private repo `Final-Factory/ffbox`. Paths in
this subsection and in section 6 are in that repo.

- **One pipeline, several front doors.** These all become the same rows, launched by the same
  scheduler under the same ceilings: the shell (`ffbox "<prompt>"`, `ffwatch submit`), the web page
  (`ffweb`), Discord (the Gateway listener into `ffwatch`), `#codereview` PR comments, and the
  `/intake` diagnose button. In FFBox's own words, "A front door decides what goes in and where the
  answer is read, never how the work runs" (`design/discord_persistent_design.txt:687-692`).
- **Unit of work**: a *conversation* holds *turns*, and each turn is one *run* in a throwaway
  container: one prompt, `claude -p`, then harvest (`scripts/ffwatch_schema.sql`). A follow-up is
  the next turn, which resumes the session. Turns have clocks: agent time is 2400 s for `ffagent`
  and 14400 s for `ffdev` (config.md, the `pools` table).
- **Agent classes** (`scripts/ffwatch.py:173`):
  - `ffagent`: fenced network, no git credential. It runs text written by strangers. Discord work
    here runs GLM-5.3 Flash; operator work here runs on the operator's Claude plan.
  - `ffdev`: the open internet and a read-only git credential. Only an operator can reach it, so its
    runs use the requesting operator's Claude plan at full capability (Lothsahn, 2026-09-28).
  - `ffdiagnose`: fenced, a 96 GB memory ceiling for `ffmode2`, and at most three containers. It
    runs intake reports.
- **Security model**: "The container is assumed hostile … prompt injection is the expected case"
  (`docs/docker-security-model.md:62-66`). **No model runs on the host.** `ffwatch` is fixed code:
  it builds the refspec, pushes, opens the PR, and composes every Discord reply from the run's
  structured verdict (`docker-security-model.md:22-60`). Model credentials stay out of containers:
  runs reach the model through a host-side proxy socket (`scripts/modelproxy.py`). The bot token,
  the push credential and Steam stay on the host (CREDENTIALS.md).
- **Trust**: the `operators` block, one entry per person, one *authenticated* id per service. The
  ids are Discord's and GitHub's numeric ids and the unix account for `shell`. Each entry also
  names the credential that pays for that person's requests (config.md, `operators`). Trust is a
  dictionary lookup in plain code (`design/trusted_ingress_design.txt`, section 9).
- **Capacity**: `max_concurrent_runs` (default 6) covers agent runs and CI together
  (`ffwatch.py:1059`, `scripts/lib-workloads.sh:2`). Each class has its own ceiling
  (`agent_pool_max`, `ffwatch.py:1154,1226`). Warm spares make dispatch take about a second.
- **Unity without a GPU**: the container uses the GameCI editor image CI uses (`scripts/Dockerfile`).
  - `ffverify` runs the EditMode suite in batchmode.
  - `ffplaytest` runs one play-mode session driven by `ffauto`, with software GL under Xvfb:
    "functional repro is sound, frame timing is worthless" (README.md, `ffplaytest`).
  - `ffmode2` runs a host and client Linux player pair and compares fingerprints, about 14 minutes
    per pair (README.md, `ffmode2`).
  - A class can boot a headless editor over MCP (`unity_mcp.enabled`, off by default).
- **CI and releases** run on the same box, through ephemeral org runners labelled
  `ffgithubrunners` (`runners/README.md`). A push to `develop` or `master` that bumps the version
  builds, checks and uploads both apps to Steam. A `develop` release's main app is set live on
  `development` and a `master` release's on `pre-release` (`scripts/release_lane.py` `SETLIVE`;
  the game repo's `scripts/release-status.py` checks it). Ben or Lothsahn move the default
  (public) branch by hand.
- **`ffintake`**: section 6.

### Where they differ, and why it matters here

| | FF Factory | FFBox |
|---|---|---|
| Who runs the model process | the portal's host, or a Mac daemon, as the logged-in user | only inside a throwaway container; never on the host |
| What decides an agent's tools, env and prompt | the portal (`LaunchSpec`) | FFBox's fixed code, per class |
| Session shape | long-lived and interactive; message it mid-turn, interrupt, approve tools | one prompt per container turn; follow-ups are new turns |
| How work leaves | workers push, including to `develop` | the host pushes an `ffbox/*` branch and opens a PR; nothing merges |
| Isolation | a guard hook (a seatbelt) | container, network fence, no credentials inside |
| Unity | real editors on a GPU, screenshots, play | batchmode, software GL, Linux player pairs |
| Who connects to whom | Macs dial out to the portal; the portal ssh-deploys them | nothing dials in, except `ffintake`, which takes uploads from anyone |

## 2. How FFBox joins

### Options

**A. FFBox as a machine, over the daemon protocol.** Rejected. Almost every message in protocol 3
conflicts with an FFBox invariant:

- `send` carries a `LaunchSpec` whose system prompt, tools and env the portal chooses
  (`server/launch.ts:15-48`), and the daemon runs the Agent SDK on the host
  (`machine/daemon.ts:272-280`). FFBox runs no model on the host, and its classes decide tools and
  network.
- The spec carries the portal's Claude token (docs/machines.md, "Claude account"). FFBox keeps its
  credentials in its secrets file and bills per operator.
- The portal installs and redeploys the daemon over ssh from its own code
  (`server/machines.ts:136-160`, `:307-342`). That means an ssh key into FFBox and a code path
  Lothsahn does not review.
- `fs`, `switch` and `unity` assume one long-lived clone and editor (`machineProtocol.ts:18-29`).
  FFBox has neither.

A daemon that ignored most of the spec on FFBox would leave a protocol whose messages mean
something different on one machine than on the others.

**B. FFBox as a remote sandbox provider**, where FF Factory allocates workspaces on FFBox and drives
its own workers there. Rejected for the same reasons. It also does not fit how FFBox works: a run's
workspace is a tmpfs restored from the CI cache and destroyed with the container (README.md, "How
it fits together").

**C. Federation: FF Factory becomes one more front door into FFBox's pipeline.** Chosen.

- It is what FFBox's own design says a new source must be (`discord_persistent_design.txt:687-692`).
  FFBox keeps deciding how the work runs: class, network, clocks, credential and publication.
- FF Factory's side reuses code it already has: an authenticated WebSocket from a remote process,
  a hashed token, reconnection and protocol versioning (`server/machines.ts`,
  `machine/daemon.ts:122-180`).

### Transport: the FFBox side dials out

There are two ways to carry option C:

1. FF Factory calls an HTTPS API on FFBox. That needs a new listener on FFBox that BEAST can reach.
   `ffweb` is not that API: it is a page for people, behind a shared-password login.
2. **A connector on FFBox connects out to FF Factory's public URL**, the Tailscale Funnel URL the
   Macs already use (docs/machines.md, "Requirements"). Nothing new listens on FFBox, and
   stopping one unit ends the integration.

We pick 2. The connector:

- lives in the **ffbox repo**. Lothsahn reviews it and FFBox's own updater deploys it. FF Factory
  never installs or updates it.
- is fixed code with no model. It reaches `ffwatch` only through its CLI (`ffwatch submit --json`,
  `stop`, `status`, `diagnose`) and read-only queries, so `ffwatch` stays the only writer.
- runs as its own unix account, holding nothing but its connector token.
- reaches FF Factory over HTTPS. **FFBox does not join Ben's tailnet**: `ffdev` containers share
  the host's network (`docker-security-model.md`, "The class that is not fenced"), so a tailnet on
  the FFBox host could put BEAST and the Macs within their reach.

On FF Factory's side the connector talks to a new endpoint, say `/provider`, with its own token
type. **That token is not an `/mcp` API key**, since an API key can do anything a person can
(`server/mcp.ts:18`).

### The provider protocol (sketch, version 1)

The protocol is narrow on purpose. Every message is data, and neither side can make the other run
code.

FFBox → FF Factory:

| message | carries |
|---|---|
| `hello` | protocol version, connector version and commit, and FFBox's page URL |
| `capacity` | each class: network (`fenced`/`open`), `gpu`, `model`, `tier` (`full`/`simple`), optionally `models` (the model and tier per requester: `operator`, `discord`), Unity modes (`batchmode`, `playtest-softgl`, `mode2-pair`, `editor-mcp` when enabled), free and max slots; plus queue length, whether FFBox is draining or updating, and subscription holds |
| `conversation` | a summary of any FFBox conversation: id, source (discord, intake, codereview, fff, shell, web), whether the opener was an operator or a player (no names or ids), title, state, class, branch, PR, verdict, cost, and the dedupe key when known |
| `intake` | one filed report's manifest facts (section 6) |
| `accepted` | a work request FFBox took: its conversation id, and `billedTo`, the user id whose account it charges (must be the request's `requestedBy`) |
| `result` | for a turn FF Factory submitted: the final answer text, branch, PR, `no_branch_reason`, verdict, cost, and a link to the run on `ffweb` |
| `delegation` | (phase 7) a request for GPU-side work from an operator's conversation or an `ESCALATE` diagnosis |
| `refused` | a request FFBox would not take, and why: `unknown_requester` or `no_account` (no account for the person it is for), class not allowed, budget hold, draining, already diagnosed |

FF Factory → FFBox:

| message | carries |
|---|---|
| `submit` | request id, `requestedBy` (the FF Factory login it is for: user id and display name, no credential) and `trigger` (`person` or `automatic`), title, prompt, requested class (`fenced` by default), optional base or branch, optional conversation id for a follow-up, and `untrustedInput` |
| `diagnose` | report ids, the board key, `requestedBy` and `trigger`. The same action as the `/intake` button, triggered by the triage in section 6 (`automatic`, for the system payer) or by a person |
| `stop` | a conversation FF Factory started, and `requestedBy` |
| `ack` | receipt of results and events |

Phase 1 built the four read-only messages (`hello`, `capacity`, `conversation`, `intake`, plus
FF Factory's `welcome` and `error`). Their exact schemas are in the contract. The work messages
(`submit`, `diagnose`, `stop`, and the connector's `accepted` and `refused`) are specified there too,
with their attribution rules, but are not sent until phase 3. A connector lists the ones it takes in
`hello.accepts`, and FF Factory sends a work message only to a connector that listed it.

The protocol has no env, tool list, system-prompt text, file read, shell, Unity control, pool
control or config write. FFBox may refuse anything and picks the class by its own rules. A request
can only make the class stricter: `untrusted_input: true` forces the fenced class, and nothing sent
from FF Factory can force the open one.

### What FFBox looks like inside FF Factory

- **A provider card** in the sidebar and in `system_status`: "FFBox: CPU only, no GPU; fenced 4/6,
  open 1/3 free; queue 2". FFBox runs do not count toward `limits.maxSessions`, as with Mac agents
  (docs/machines.md, "Limits"). FF Factory adds its own cap (`providers.ffbox.maxActive`), and
  FFBox's ceilings still apply.
- **Sessions of kind `provider`.** A session's transcript holds what was sent, the status changes
  and the result. `message_agent` becomes the next turn and `stop_agent` sends `stop`. There is no
  mid-turn message, no interrupt that keeps the run, no permission card and no `unity` tool, and
  the tool errors say so.
- **Full transcripts stay on FFBox**, behind `ffweb`'s login, because they can hold player text and
  raw model thinking. The result links to the transcript.

### What FFBox can and cannot do

It can:

- read, change and commit code, published as a PR;
- run the EditMode suite;
- reproduce play-mode behaviour with software GL, on `develop`-based workspaces;
- run two-peer determinism pairs;
- do reviews, specs and docs;
- diagnose desync and crash reports;
- take anything that reads player data.

It cannot:

- judge anything by pixels or timing: shaders, VFX, UI screenshots, performance;
- run the three-machine rig, Steam builds on real machines, Mac work or the live co-op game;
- push straight to `develop`. FFBox work lands as a PR, and someone reviews and merges it.

## 3. Security boundaries

### Rules

1. **FFBox's invariants do not move.** No model runs on the FFBox host. Class, network, clocks and
   credential are FFBox's decision. The host publishes, and nothing merges. Containers hold no FF
   Factory credential and have no route to BEAST or the Macs.
2. **FFBox initiates.** FF Factory has no ssh, no inbound port and no deploy path into FFBox.
3. **No secret crosses.** FF Factory never sends a Claude token to FFBox, unlike the Macs, and
   FFBox never sends one back. The one shared secret is the connector token. FFBox keeps it; FF
   Factory keeps only its SHA-256, as for machine tokens. Prompt text passes `redactSecrets`
   (`server/secrets.ts:41`) on the way out, and results pass it on the way in.
4. **Least privilege, both ways.** FF Factory may submit, follow up on and stop the conversations
   it opened, ask for a diagnosis of a filed report, and read summaries. It may not touch pools,
   drains, purges, the outbound Discord queue, approvals, adopt or fork. FFBox may report and
   file requests that land in an approval queue. It gets no tool belt.
5. **What comes back is data.** Results and titles can carry text players wrote or steered. The
   orchestrator treats `[ffbox]` messages like `[standing agent]` ones: it relays them and does
   not act on them (`server/agents.ts:1485`). It keeps no WebFetch.
6. **The fenced class is the default.** The open class (`ffdev`) is never used for a task with
   untrusted input. Lothsahn allows FF Factory tasks there (2026-09-27), at any size (2026-09-28).

### Player data: Discord, bug reports, saves, desync and crash reports

Today FF Factory can put player text in front of an agent that runs as Ben:

- The README's own example is "read the Discord forums and find bugs", and the orchestrator is
  told to run that in a sandbox (`server/agents.ts:1481`). A sandbox worker is covered only by the
  seatbelt guard (README.md, "Known gaps").
- A standing agent that reads Discord can write a delegation brief. Approving it starts a worker
  in a sandbox or on a Mac (`server/standing.ts:595-626`). Auto-approve can skip the human.

With FFBox in the system:

- **Player data is read on FFBox, in a fenced class.** That covers Discord reading, bug reports,
  saves, desync and crash zips, and PRs from forks. FF Factory stops running Discord-reading
  workers and standing agents on BEAST and the Macs; Max already reads Discord on FFBox.
- **The intake feed carries no player text.** Every field in an `intake` event is one `ffintake`
  computed or matched against a narrow pattern (section 6). The report's description, logs and
  saves stay in the zip on FFBox.
- **Crossing from fenced work to a GPU host goes through a person** until workers on BEAST run as a
  low-privilege user (README.md, "Known gaps"). This is one approval click by either person when a
  fenced investigation escalates. It is not coordination between the two of them. The server
  enforces it.
- **Only FFBox speaks as Max.** FF Factory never holds the bot token. The conversations it opens
  are a local kind, which FFBox never posts to Discord.

### Threat model

| threat | what limits it | what is left |
|---|---|---|
| Prompt injection in player text reaches a worker on BEAST that runs as Ben | routing rule 1, enforced in code; the intake feed carries no free text; crossing needs an approval | a person approving a bad escalation; the item shows where it came from |
| Fake or flooded reports drive agent spend | `ffintake`'s own limits; grouping; one investigation per signature; distinct-sender thresholds; per-hour and per-day caps; a storm breaker (section 6) | an attacker with many addresses can waste the daily auto budget; the reports still land for people to see |
| An investigation that read a hostile zip poisons the board, for example by claiming "duplicate of X" to stop work | a refined key merges items only when the coarse signatures match; a report on a build that already has the fix reopens the item | one signature's investigation delayed until the next report arrives |
| FF Factory is compromised (public URL, logins, API keys) | FFBox accepts only `submit`, `diagnose` and `stop` for known logins; fenced by default; per-source caps and budgets; PR only, no merge; FFBox's kill switch | spending the credential a login maps to; PRs queued for review |
| The FFBox connector or host is compromised | everything it sends is data; requests wait for a person; the token cannot reach `/mcp`; size and rate limits on `/provider` | a false board or feed; noise in the approval queue |
| The connector token leaks | the two rows above; hashed on FF Factory; re-pairing rotates it | activity until it is revoked |
| A secret sits in prompt text | redaction both ways; containers never hold model credentials | formats `redactSecrets` does not know |
| Lateral movement between networks | FFBox reaches only FF Factory's public HTTPS URL; no tailnet on FFBox; nothing inbound | none new |
| Lothsahn's session drives BEAST | roles checked in tool handlers (section 7) | any launch on BEAST runs as Ben's Windows user until the low-privilege worker exists |

## 4. Where a task runs: the routing policy

The orchestrator describes what a task *needs*, not where it should go:

```
needs: { gpu, visual, mac, rig3, liveGame, untrustedInput, securitySensitive, unity: none|batch|playtest|mode2|editor }
```

The server picks the target. The first matching rule wins:

1. **Untrusted input → FFBox, fenced class.** This covers anything that reads or acts on data from
   outside the team: Discord, player reports, saves, desync and crash zips, fork PRs, and web pages
   it will follow. The server refuses a sandbox or Mac target for such a task unless a person
   approved the crossing. If the task also needs a GPU, FFBox reads first, and the GPU follow-up is
   an escalation (section 6).
2. **GPU, rendered visuals, a Mac, the three-machine rig or the live game → a BEAST sandbox or a
   Mac. Never FFBox.** Examples: shaders, VFX, UI screenshots, performance, the honest co-op
   sittings, Steam client tests.
3. **Security-sensitive → FFBox.** That means work that runs or inspects code or content the team
   did not write, such as a new package, a mod, a crash dump or an unknown build. It also means
   work that should not run with BEAST's credentials in reach: the Claude token, the gh login, the
   ssh keys to the Macs. Changes to FF Factory itself or to BEAST's setup are the exception,
   because they have to run where they apply.
4. **CPU-only → a BEAST sandbox when one is free, otherwise FFBox.** CPU-only covers code, EditMode
   tests, two-peer pairs, reviews, specs and docs. Free means an `unused` sandbox with room under
   `limits.maxSessions`, or room to create one. This is the policy as stated. Whether to prefer
   FFBox even when a sandbox is free is open question 2.
   - **4a. Operator work may go to FFBox as requested, at any size.** Work an operator asks for
     runs on that operator's own Claude plan at full capability, so the orchestrator may send it
     to FFBox whenever that is asked for or rules 3 and 4 point there: security-sensitive work,
     work that reads player input, CPU-only work, or when BEAST's sandboxes are busy. There is no
     "simple only" limit (Lothsahn, 2026-09-28). The orchestrator reads each class's model and
     tier for operator work from the `capacity` message (`ffbox_activity` shows them). A `simple`
     tier, today GLM-5.3 Flash, applies to Discord-originated work, which FF Factory does not send.
5. **Nothing free → the task waits on the board.** Nothing is created past the limits.

In tools:

- `start_agent` gains `target: { provider: "ffbox", class?: "fenced" | "open" }` beside `sandbox`
  and `machine`, plus a `needs` argument. `pick_target(needs)` returns the rule that matched, the
  place and the reason. `start_agent` applies it when no target is given.
- **Rules 1 and 2 are checked on the server.** In FFBox's own words, "Everything the container is
  told not to do must also be something it cannot do" (`docker-security-model.md`, "The preamble is
  advice"). Delegation requests from standing agents that read player text, and anything filed
  through the connector, carry `untrustedInput` from their source, so the orchestrator cannot drop
  the flag by leaving it out.
- The delegation `pickTarget` (`server/standing.ts:563`) gains `ffbox`, and auto-approve gains
  `targets: "ffbox"`, the natural setting for a Discord triager.
- The orchestrator brief gets the rules in one short section, beside the ones on machines and
  standing agents (`server/agents.ts:1480-1486`).

## 5. Zero coordination: the board

Neither person should need to tell the other what they or their agents are doing. The server
checks claims when work starts, so nothing depends on an agent or a person remembering to look.

### Work items

A list in FF Factory's state, beside sandboxes and standing agents:

| field | meaning |
|---|---|
| title, kind | `desync`, `crash`, `bug`, `feature`, `review`, `ops` |
| key | the dedupe key: a desync signature (section 6), `issue#N`, `pr#N`, `spec-082`, a crash signature |
| source | a person, the orchestrator, a standing agent, FFBox intake, FFBox Discord, `#codereview` |
| claim | the session, sandbox, Mac or FFBox conversation working on it, since when, and for whom |
| state | `open`, `investigating`, `pr-open`, `merged`, `fixed-in <version>`, `wontfix`, `duplicate-of <id>`, `needs-info`, `escalated` |
| evidence | report ids, sender counts, versions seen, the diagnosis verdicts |
| links | branch, PR, spec, the `ffweb` conversation |

### How claims stay automatic

- **Starting keyed work claims its key, on the server.** `start_agent`, the `submit`/`diagnose`
  requests and approved delegations all carry the item. The server refuses a second live claim on
  the same key and names the holder. Workers get `claim_work`, `find_work` and `release_work` for
  keys they discover mid-task, such as a desync signature found in an audit, and the worker brief
  says to call them.
- **A claim lapses** when its session has been idle past a limit or its FFBox conversation ends,
  so an abandoned claim does not block the next agent.
- **FFBox's own work is on the board without FFBox changing its flow.** Each `conversation` event
  becomes or updates an item held by that conversation. From phase 7, FFBox also asks the board
  before it starts a diagnosis on its own, so the check runs both ways.
- **FFBox workers doing operator work may claim any item**: they run Claude on the operator's plan
  (Lothsahn, 2026-09-28; rule 4a). A conversation on a `simple` tier, which today means Discord work
  on GLM-5.3 Flash, claims only simple items.
- **Loth's agents outside FF Factory** reach the board through `/mcp` with a user-bound key
  (section 7). Doing so needs no conversation with Ben.
- **Overlapping PRs are flagged.** A background job reads the open PRs against `develop` and flags
  items whose PRs touch the same files. Both sessions get a message, so a clash surfaces before
  review, not after merge.
- Spec numbers keep their git-based claim in `specs/STATUS.md` in the game repo, and the board
  links to it.

### Standing agents and Max

- A standing agent's delegation request becomes an item. Once approved, `pickTarget` includes
  FFBox, and a Discord triager's requests go there by default (rule 1).
- Max's requests (phase 7): an operator's FFBox conversation, or an `ESCALATE` diagnosis, files a
  `delegation` through the connector. FF Factory queues it, marked with its source. A player's
  conversation cannot file one.

## 6. Automatic desync and crash intake

Today players' games upload desync and crash reports to `ffintake` on FFBox. The `/intake` page
lists them, and a person clicks a report to hand it to a diagnosis agent. Lothsahn's agents work on
desyncs only when he asks, and Ben's agents fix the desyncs they find in their own audits. The
proposal: every report is triaged by fixed code as it arrives, and every new fork signature gets
exactly one investigation, routed to FFBox's fenced class and claimed on the board.

### What ffintake gives us

- **The upload.** The game's `[DesyncUpload]` queue (`Assets/Scripts/Diagnostics/DesyncReportUploader.cs`,
  `ReportUploadQueue.cs` in the game repo) sends a report only with the player's consent. It keeps
  it for up to 7 days (`ReportUploadQueue.MaxAge`), honours `Retry-After`, and after a `429` pauses
  every queue for 15 minutes (`RateLimitPause`). `ffintake` answers `201` with its report id, `200`
  for a retry, and `429 rate_limited` past its limits (ffbox README.md, "The protocol").
- **The limits** (config.md, `intake.rate_limits`): 12 reports an hour per sender after a burst of
  10, where a sender is an IPv4 address or an IPv6 `/64`, and 600 an hour for everybody after a
  burst of 60. The dataset has a quota, and reports are kept 21 days.
- **What is safe to read.** `ffintake` never unpacks a zip. The manifest holds only values the
  server checked or computed (`"trust": "untrusted"` marks the zip, not the manifest). For a
  desync it reads a few capped facts out of the zip, which must match narrow patterns
  (`scripts/ffintake.py:963-1030`; `CORRELATION_RE` and `SURFACES_RE` at `:870-875`):

  ```json
  "desync": { "group": "fc5620980cd46738", "correlation_id": "7-7240-2", "diverged_client": 2,
              "role": "host", "session_epoch": 7, "verdict_heartbeat": 7240,
              "diverged_surfaces": "minerBots+census", "happened_at": "…",
              "host_combined": "34C4…", "peer_combined": "CDF5…" }
  ```

  `group` joins every peer's report of *one* desync event. It hashes the game version, the session
  guid, the epoch and the heartbeat (ffbox README.md, "Desync pairs"). Nothing joins the same fork
  across sessions yet. That is the gap below.
- **Diagnosis.** `ffwatch diagnose <report> --by <login>` opens one conversation per report, keyed
  `intake:<report id>`, with the group's partner reports attached. It runs in `ffdiagnose` on
  `develop`. The brief (`scripts/intake/desync.md`) has the agent reproduce the desync with
  `ffmode2`, fix it and verify it. The verdict is `NEEDS-INFO` when the report is not enough, in
  which case the PR only makes the next report collect more. It is `ESCALATE` when a fix needs
  three peers, in which case it writes a handoff. `/intake` then tracks the PR through
  `fix proposed`, `fixed` or `obsolete` (ffbox README.md, "Diagnosing a report").

### The pipeline

```
player's game ──upload──► ffintake (FFBox) ── files report + manifest
                                     │
         connector reads new manifests (no zip), sends `intake` events
                                     ▼
FF Factory triage (fixed code, no model)
   group → signature → match known / fixed / regression → board item
                                     │  new or regressed signature, within budget
                                     ▼
   `diagnose` → FFBox ffdiagnose (fenced): reproduce, fix, PR ─┐
                                     │                          │ result, verdict, root-cause key
                                     ▼                          ▼
   ESCALATE ──(one approval)──► BEAST / three-machine rig    board: pr-open → merged → fixed-in <version>
```

### Step 1: the event feed

The connector notices each new report directory. `ffintake` renames a finished report into place in
one step, so a directory it sees is complete. It sends an `intake` event with:

- the report id, kind, `received_at`, `game_version` and `platform`;
- the whole `desync` block;
- the sender's `address_hash` re-keyed with a per-integration salt, so FF Factory can count
  distinct senders without learning FFBox's hashes;
- the report's size.

Nothing else crosses: no description, no log line, no file name from inside the zip. The connector
needs read access to manifests only. The cleanest way is a small read-only `ffwatch intake-events
--since <cursor> --json`, so the connector does not join the `ffintake` group. That choice is
Lothsahn's.

### Step 2: signatures, and matching against known forks

Fixed code in FF Factory computes two keys:

- **The event**: `group`, taken as is. Every peer's report of one desync folds into one event.
- **The coarse signature**: `desync:<version line>:<diverged_surfaces>`. The version line is the
  major.minor.patch series, so one fork seen across a day of builds stays one item. It is computed
  with no model and needs only pattern-checked fields. Two root causes that diverge the same
  surfaces share a coarse signature until a diagnosis tells them apart.
- **The refined key**: added after a diagnosis. The verdict names the root cause as a structured
  field: the system and the `file.cs:line` of the fix, validated against the repo by fixed code.
  Items with the same refined key merge. They merge only when their coarse signatures also match,
  so an agent that read a hostile zip cannot fold an unrelated fork into another.

Each new event is matched against the board:

| the board has | on this event's build | then |
|---|---|---|
| nothing with this signature | — | a new item; queue an investigation (step 3) |
| an item that is `investigating` or `pr-open` | — | attach the event as evidence. No new agent |
| an item fixed in version F | older than F | attach as "fixed in F". No agent |
| an item fixed in version F | F or newer | **a regression**: reopen the item and queue an investigation, attaching the old PR |
| an item at `needs-info` whose PR added report data | a build with that PR | queue a re-investigation, since the new report has what was missing |
| an item at `needs-info` | older than that PR | attach. No agent |

"Fixed in F" comes from the merge: the first release whose version commit contains the fix commit.
FFBox's mirror can answer that with `merge-base --is-ancestor`, and its release lane already knows
which commit bumped which version (`scripts/release_lane.py`).

Ben's own desyncs join the same flow. A Ben-side worker that finds a fork in an audit claims its
coarse signature on the board, computed from the same report fields the game writes. A
consenting BEAST or Mac player also uploads through `ffintake` like any player's.

### Step 3: investigation workers

- **Routing**: player-uploaded data is untrusted input (rule 1), so the investigation is a
  `diagnose` on FFBox in `ffdiagnose`, exactly as the button does it today. The only difference is
  who pressed it. It carries the board item, and FFBox refuses a report that is already diagnosed.
- **One live investigation per signature.** New events attach as evidence. Following FFBox's
  existing rule, a partner report that arrives mid-diagnosis is not handed over automatically; the
  item records it.
- **Outcomes, all automatic:** a fix PR sets the item to `pr-open`, a merge sets it to `merged` and
  then `fixed-in <version>`, a closed PR sets it back to `open`, and `NEEDS-INFO` sets it to
  `needs-info` and waits for the better report.
- **`ESCALATE`** (a three-peer fork) sets the item to `escalated` and files a delegation for the
  three-machine rig. That crosses from a fenced run to Ben's machines. Until BEAST workers run as a
  low-privilege user it needs one approval click from either person. Today the handoff is free text
  (ffbox README.md, "A fork that needs three peers"). The proposal is that `desync.md` also asks for
  structured fields: surfaces, heartbeats, `file.cs:line` references, and the scenario as an
  `ffauto` chain. Fixed code then validates the references against the repo and the chain against
  its grammar, and builds the BEAST worker's brief from them. The free-text hypotheses follow under
  a header saying they came from an investigation of player data.
- **Crashes** follow later (phase 6). A crash manifest has no signature: the zip is never parsed on
  the host. So a crash first gets a cheap fenced read, billed and capped separately, that returns a
  structured signature (exception type and top frames). The same match-and-investigate rules then
  apply.

### Step 4: budgets, and what a storm does

Each layer bounds the next:

| layer | bound |
|---|---|
| upload | `ffintake`'s per-sender and global limits; the game backs off on `429` |
| grouping | all peers of one event → one event; all events of one signature → one item |
| per signature | at most one live investigation; re-investigation only on a regression or a better report |
| trust | a signature is auto-investigated once it has reports from at least 2 distinct senders, or a host and client pair of one event. A single sender's signature waits for a person or for budget left at the end of the day |
| concurrency | at most 2 automatic investigations at once (`ffdiagnose` holds 3, leaving 1 for people) |
| rate | at most 3 new automatic investigations an hour and 20 a day (Ben, 2026-09-27) |
| money | automatic investigations carry the system payer (config `systemPayer`, Ben) as `requestedBy`, so FFBox bills Ben's second Claude account, whose token Ben gives Lothsahn directly (section 7); plus FFBox's `max_budget_usd` per turn and its subscription holds |
| **storm breaker** | more than 5 new signatures in an hour, or one version's reports at more than 5 times its daily average: automatic starts stop, both people get one notice, and the queue waits ranked by distinct senders, then newest build. Starts resume when the rate falls back, or when a person says so |
| ordering | the newest `develop` build first; builds older than a known fix last |

A desync storm from one bug in one build becomes one item and one investigation. Fifty different
forks in an hour trips the breaker after five, and both people get one notice.

### What people still see

Both people see the board, the `/intake` page and the notices. Nobody has to press anything for a
report to be investigated, and nobody has to check with the other person first. Their only
decisions are merging PRs, approving an escalation onto Ben's machines, and deciding on a storm
after the breaker has stopped automatic starts.

## 7. People: Ben and Lothsahn in one orchestrator

### What exists

Built 2026-09-27 ([identity.md](identity.md)):

- **Logins with a display name and a role**: owner (Ben) or member (Lothsahn). API keys can be bound
  to a login.
- **Attribution.** Every person's message records its author, and the orchestrator reads it as
  `[from Lothsahn]`. Each of the following carries the person as `requestedBy`:
  - workers started by hand, by the orchestrator (`start_agent`) or through a bound `/mcp` key;
  - the orchestrator's follow-ups (`message_agent`);
  - standing runs started by hand;
  - delegation approvals (`approvedBy`).

  The orchestrator acts for the author of the latest person's message, or names another person with
  `for_user`. Agent cards and details show who an agent works for.
- **Local billing.** A worker runs on its person's own Claude token when config `userClaudeEnv` has
  one, and on the owner's otherwise. This is how the agents Lothsahn asks for on Ben's machines (BEAST
  sandboxes and the M3) run on Lothsahn's account.
- Roles are not enforced yet, and an API key is still a full tool belt (`server/mcp.ts`).

### Proposal

- **Attribution** (built; see above). Board claims and notifications will name the person too, once
  they exist.
- **Roles, checked in the tool handlers:**

| | owner (Ben) | maintainer (Lothsahn) |
|---|---|---|
| sandboxes on BEAST: create, start agents, Unity | yes | yes |
| FFBox tasks, fenced; board; delegation and escalation approvals | yes | yes |
| FFBox tasks, open class | if FFBox lists him as an operator | if FFBox lists him as an operator |
| the M3 | yes | yes (Ben, 2026-09-27) |
| the M5 (Ben's main clone, next to his uncommitted work) | yes | no |
| `add_machine`, `set_app_config`, `request_app_update`, `republish_public`, host recovery, deleting someone else's sandbox, users and keys | yes | no |

- **API keys belong to a user** and inherit that user's role.
- **One shared orchestrator chat** (Ben, 2026-09-27). Both people type into the same
  conversation, and every message carries its author. We had recommended one conversation per
  person, because in a shared chat one turn can answer both people, which makes a tool call's
  authority ambiguous. The role check therefore uses the author of the message the turn answers;
  a turn that answers both uses the narrower role, the maintainer's.
- **Mapping to FFBox.** FFBox's `operators` block gains an `fff` id per person, which is the FF
  Factory login (`requestedBy.userId` in every work message), following its "one id per service"
  rule. The connector submits under a new local kind `fff`, with the opener recorded as
  `fff:<userId>`, the way `/intake` records `web:<login>`. An unknown user id is refused
  (`unknown_requester`).
- **Billing: per person** (Lothsahn's request, 2026-09-27; this replaces "everything on Ben's second
  account"). FFBox charges the account the `requestedBy` person's operator entry names:
  - Ben's requests go to Ben's second Claude account, whose token Ben gives Lothsahn directly.
  - Lothsahn's requests go to Lothsahn's own account.
  - Automatic intake work carries the system payer (config `systemPayer`, Ben) and goes to Ben's.

  An operator with no account is refused (`no_account`), never billed to someone else, and
  `accepted.billedTo` says whose account was charged. Tokens never cross the connector (rule 3).
  The schema and the MUST rules are in the contract, "Work messages".
- **Billing on Ben's machines** (the same idea, locally; [identity.md](identity.md), "Local billing"):
  - Work Lothsahn asks for on BEAST sandboxes or the M3 runs on Lothsahn's own Claude token when FF
    Factory has one. It is config `userClaudeEnv.lothsahn`, write-only and redacted like `claudeEnv`,
    and chosen per worker by `requestedBy`.
  - Without one, work runs on the owner's account.
  - The shared orchestrator always runs on the owner's.
- **FFBox trusts FF Factory's login.** That is a real delegation of trust. Anyone who takes over FF
  Factory can submit as either person. The limits are section 3, plus per-source caps FFBox can set
  for `fff`: allowed classes per person, and turns and spend per day.

### Before Lothsahn gets a login: a decision for Ben

Every BEAST worker runs as Ben's Windows user. The guard is a seatbelt (README.md, "Known gaps").
So a login that can start a BEAST worker is, in effect, a shell as Ben on BEAST, with his gh login
and the Claude token in the environment. The same already holds for any login or API key. The
fix, planned but not built, is running workers and editors as a low-privilege local user
(README.md, "Known gaps"). It shrinks this grant and would also let escalations start without the
approval click. Ben decides whether Lothsahn's login waits for that fix or comes first, with the
risk accepted.

Ben has decided where that login may reach (2026-09-27): BEAST sandboxes and the M3, not the M5.

The mirror image holds on FFBox. Lothsahn decides whether the `fff` source ever gets the open
class.

## 8. Migration plan

Each phase ships on its own and can be switched off by config or by stopping one unit. Turning
one off leaves the earlier phases working.

| phase | what | where | off switch |
|---|---|---|---|
| 0 | this document; answers to section 9 | ff-factory docs | — |
| 1 | **Visibility, read-only.** `/provider` with its own token type and a provider card. The connector sends `hello`, `capacity`, `conversation` and `intake` events. Nothing can be submitted. *FF Factory's side built 2026-09-27; the connector is next* | FF Factory (Ben); the connector and `intake-events` in the ffbox repo (Lothsahn) | stop the connector unit; `providers.ffbox.enabled: false`; revoke the token |
| 2 | **The board and automatic triage, no agents.** Work items, keys, enforced claims, the tools, worker-brief lines, the PR-overlap job. Intake events become items with signatures and known/fixed/regression matching. Both people watch it for a week to tune the signature | FF Factory | the claims check is one switch; items are additive |
| 3 | **Submit and diagnose, fenced only.** `submit`, `diagnose`, `stop` and `result`; sessions of kind `provider`; redaction both ways; the `fff` kind; FFBox bills Ben's second Claude account | both | FFBox refuses `fff`; FF Factory hides the target |
| 4 | **Automatic investigations.** Triage starts `diagnose` for new and regressed signatures under every bound in section 6: 2 at a time and 20 a day to start | FF Factory | `intake.auto: false`; the storm breaker; FFBox's per-source cap |
| 5 | **Routing.** `needs`, `pick_target`, the rules, rule 1 on the server, FFBox as a delegation target. Discord-reading work moves off BEAST and the Macs | FF Factory | a config switch; manual targets still work |
| 6 | **People and crashes.** Attribution, user-owned keys, the shared chat and per-person local billing are built early (2026-09-27, [identity.md](identity.md)). Left for this phase: roles enforced, Lothsahn's login (BEAST and the M3), `fff` ids in FFBox's `operators`, and crash signatures by a capped fenced read | both | remove the login; `intake.crash.auto: false` |
| 7 | **Both directions.** Max and `ESCALATE` delegations into FF Factory's queue; FFBox checks the board before its own diagnoses and operator dev turns | both | the connector stops sending `delegation`; FFBox skips the check |

Phase 1 teaches both sides the connection, the token and the load, and cannot do harm. Phase 3 is
the first to spend money on FFBox, on Ben's second Claude account. Phase 4 is where
Lothsahn's FFBox starts working on desyncs nobody asked for, so it starts capped at 20 a day.

## 9. Open questions

For Ben and Lothsahn together:

1. ~~**Who pays** for FF Factory's FFBox runs, and what daily cap?~~ Answered 2026-09-27: Ben's
   second Claude account, through a token Ben gives Lothsahn directly; 20 automatic
   investigations a day to start.
2. **CPU-only work:** FFBox only when no GPU sandbox is free (as stated), or always, to keep GPU
   slots for GPU work?
3. ~~**One shared orchestrator chat, or one per person?**~~ Answered 2026-09-27: one shared chat
   (section 7).
4. **The desync signature:** is `version line + diverged_surfaces` the right coarse key? What
   structured root-cause field should `desync.md` ask for, so that diagnoses refine it?
5. **Automatic-work numbers:** the daily cap is 20 (Ben, 2026-09-27). Are 2 at once, 3 an hour,
   2 distinct senders, and the storm thresholds right to start with?
6. **Escalation onto Ben's machines:** one approval click until the low-privilege worker exists,
   or never automatic?
7. **How much of an FFBox run crosses:** the result and a link (proposed), a condensed tool log, or
   the whole transcript?
8. **Where the board lives:** FF Factory's state (proposed, simplest), or GitHub Issues and
   Projects, which would be durable and visible without FF Factory?

For Ben:

9. Does Lothsahn's login wait for the low-privilege worker user, or come first (section 7)?
10. ~~May Lothsahn's sessions start work on the Macs?~~ Answered 2026-09-27: the M3 yes, the M5 no.

For Lothsahn:

11. Is the connector acceptable as a unit in the ffbox repo, as its own account, dialing out to FF
    Factory's public URL? Inside `ffbox.target` or beside it?
12. Is `ffwatch intake-events` the right way to read manifests, rather than the connector joining
    the `ffintake` group?
13. ~~Should the `fff` source ever get the open class?~~ Answered 2026-09-27: yes. On 2026-09-28
    Lothsahn clarified that this covers any operator work, not only simple work (rule 4a).
14. Should FFBox's own dev turns (a Discord request from you) also claim on the board, so that your
    agents and Ben's never fix the same fork?
15. Should FF Factory show CI runner state read-only (queue, last release), or keep CI out of scope?
    Releases stay on FFBox either way.

About this document: the ff-factory repo is public and the ffbox repo is private. This document
cites ffbox paths but leaves out its identifiers, addresses, account names and the open items of
its own audits. The detailed connector and intake-feed spec belongs in the ffbox repo.
