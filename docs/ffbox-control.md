# Controlling FFBox from FF Factory (w553 design, for Lothsahn's review)

**Status:** design only. Nothing here is built until Lothsahn agrees (he owns FFBox and FF Factory's deploys).

**Ask** (Ben, 2026-10-06): "cant you just pause ffbox without pinging loth in the future? if not can we update fff to
do that?", widened to "i want you to make general commands to FFbox not just pausing CI, just like you can interact
with all my machines". The first deliverable is pause/resume. After that come holds and drain, service restarts, CI
inspection and control, live process and load state, and admin commands on the host.

The facts this rests on are in `docs/ffbox-control-facts.md`: ffbox master `00e84ab`, read with file:line.

## Decisions for Lothsahn

1. **Shape (recommended: A).** A small control daemon on the FFBox host that runs a fixed, reviewed set of commands.
   It is FF Factory's machine daemon in a control-only mode: no agents and no Claude tokens on the box. The
   alternatives are below, with why they lose.
2. **CI pause (recommended: label split).** Release runs get their own runner label, so a pause can stop only
   non-release CI. This needs a small game-repo workflow change plus `ci_lane` minting per label. Without it, a pause
   can hold containers only, or all CI, release included.
3. **"Admin commands on the host" means the reviewed command set.** It does not mean a free shell. Adding a command
   is a PR to `ffboxctl` that you review. Anything else stays with ssh.
4. **Who may call what.**
   - Read-only commands: any FF Factory orchestrator, or a worker on an owner's request.
   - Commands that change something: only when an owner asked in their own words (`user_asked` plus an owner's
     `work_id`, as FF Factory's other reserved tools work).

## Shapes compared

| Shape | Works with the connector down | Containers can reach it | Claude tokens or agent shells on the box | Fits FFBox's model | Verdict |
|---|---|---|---|---|---|
| **A. Control daemon, fixed commands.** FF Factory's machine daemon in control-only mode, as its own unprivileged account (`fffctl`). It runs `ffboxctl <command>` through a sudo rule that allows only that program | Yes: its own process, token and link | No: it listens on nothing, has its own uid, is not in the docker group, and its token file is `0600` | No | The verbs live in FFBox's repo, reviewed like any FFBox change; FFBox validates every argument host-side | **Recommended** |
| B. More connector messages, through the spool the design already allows (`/run/fffconnector/<sub>/<id>.json`, which ffwatch re-validates) | No: it fails exactly when the connector is down (2026-10-06 18:44 UTC) | No | No | Yes for pause/resume, but "admin commands" do not fit a spool that ffwatch reads | Good for pause only; fails the offline requirement |
| C. A full FF Factory machine with agents on the host, like the Macs and PCs | Yes | No, as A | **Yes**: FF Factory's Claude tokens and agent shells beside hostile containers, so a container escape (E2) reads them | A free shell bypasses the verb review | Not recommended |

## The pause (first deliverable)

- **State:** one file, `~/.config/ffbox/paused.json`, with:
  - `by`: an FF Factory user id, e.g. `fff:ben`;
  - `why` and `since`;
  - optionally `until` (a time) or `untilRelease` (a version);
  - `scope`: `containers`, `ci` or `all`.

  It is separate from `draining`, because the updater lifts the drain files after every update it applies (facts 3).
  The updater never touches `paused.json`.
- **Containers:** `schedule()` and `keep_pool` check it beside the kill switch, the failsafe and the drain.
  - New ffagent, ffdev and ffdiagnose turns wait; queued turns stay queued.
  - Running turns finish, unless the pause asks to drain: then the idle staged containers go too, as `ffwatch drain`
    does today.
  - Discord is not muted. That is the kill switch, a different thing.
- **CI:** `ci_lane.keep` stops minting runners for the non-release label (decision 2). Release jobs keep being served,
  and no job is cancelled.
- **Ends:**
  - by `resume`;
  - at `until`;
  - or when the release ledger shows `untilRelease` landed: every upload done and set live (facts 9), checked on
    each ffwatch pass.
- **Seen:**
  - `capacity.holds` gets `paused by <name>: <why> (since …, until …)`. The `status` query gets a `paused` block.
  - So `ffbox_activity status` and the dashboard show who paused it, why and since when.
  - A new `capacity.state` value is not needed; it would need a connector change (facts 8).

## CI: how a pause stops runners taking work (worked out for Lothsahn, 2026-10-06)

Labels: **[M]** measured, **[S]** sourced (doc or code), **[G]** a guess.

### 1. How FFBox runs its runners today

- **Only JIT runners.** Every one is an org-level just-in-time runner: `POST /orgs/Final-Factory/actions/runners/generate-jitconfig`, with name, `runner_group_id` 1 and labels [S] ffbox `runners/lib/gh.sh:159-169`. A JIT runner "performs at most one job before being automatically removed" [S] [GitHub, Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners). There is one container per runner, launched with `FFGHR_JITCONFIG` [S] `ci_lane.py:662`. Nothing re-registers: each job gets a fresh registration.
- **Labels and group.** The labels are `Linux,X64,ffgithubrunners` [S] `runners/lib/config.sh:236`. The group is 1, Default, the only group on the free plan [S] `gh.sh:157-158`.
- **The pool.** `keep()` adds at most one runner per pass while the pool is short of its idle target, within the lane's ceiling and the box's [S] `ci_lane.py:1366-1450`, `may_admit` `:434-451`.
- **What starts it, measured on Build 81** (run 37508889022, 0.50.0.81) [M]:
  - The GitHub-hosted job "Is this push a version bump" finished at 18:07:48.
  - Release (win64), Release (osx) and Test in editmode were created at 18:07:48, all asking for `ffgithubrunners`.
  - They started 2-18 s later on `ffghr-loth2400-{3,1,4}-…`.

### 2. How a pause stops new work without killing a running job

| Way | Verdict |
|---|---|
| **Stop minting JIT runners for the paused label** | **Used.** No new runner means no new job for that label. A job waits "queued until a runner comes online" [S] (GitHub, same page) |
| **Delete the idle runners of the paused label, registration first** | **Used.** This is `drop_idle`'s rule, measured on the box on 2026-09-28: GitHub refuses to delete a runner that has a job, and once it has deleted one it gives it none, so the delete is also the lock [S] `ci_lane.py:1652-1660`. A runner GitHub keeps is left to finish. Without this, each idle runner (target 1 today) would take one more non-release job |
| Stopping the runner service between jobs | Does not apply: a JIT runner runs one job and its container ends [S] |
| Removing a label from a registered runner (`DELETE /orgs/{org}/actions/runners/{id}/labels/{name}`) | Possible: the App's runner permission covers it [S] [REST docs](https://docs.github.com/en/rest/actions/self-hosted-runners). Not needed, because deleting idle runners is simpler and already proven on the box. Whether a label change touches a job already assigned: not documented [G: it does not] |
| Runner groups (restrict to workflows) | Not available: extra groups and workflow restriction need GitHub Team or Enterprise; Final-Factory is on Free [S] [runner groups docs](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/managing-access-to-self-hosted-runners-using-groups), `gh.sh:157-158` |
| "Disabling" a runner | No such REST call: only delete [S] REST docs |
| A gate in the workflow (`if: vars.X`, or a job that waits) | Rejected: `if` skips the job, which loses it. A waiting job burns hosted minutes and needs admin to set a repo variable |

- **A job already assigned** finishes: nothing stops busy containers [S] `ci_lane.py:1386-1395` (a drain serves running jobs).
- **A queued job** waits, but "a job can be in the queue for 24 hours before it is automatically cancelled" [S] [GitHub, limits](https://docs.github.com/en/actions/reference/limits). So a pause is capped below that: 20 h, after which ffwatch resumes by itself. Asking for longer is refused.

### 3. Marking a release run before its first self-hosted job

- **The decision already exists.** Job `versionBump`, "Is this push a version bump", runs on `ubuntu-latest` and outputs `bumped=true` for a version bump [S] game `main.yml:99-130`. `testRunner` and `release` both `need` it [S] `:132`, `:681`.
- **Self-hosted jobs are created only after it finishes** [M] (§1, created at 18:07:48).
- **The change:**
  - `testRunner`: `runs-on: ${{ needs.versionBump.outputs.bumped == 'true' && 'ffrelease' || 'ffgithubrunners' }}`.
  - `release`: `runs-on: ffrelease`, since its `if` already needs `bumped`.
  - The `needs` context is allowed in `runs-on` [S] [contexts table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts): "github, needs, strategy, matrix, vars, inputs".
- **Where versionBump is skipped** (pull requests, dispatches), `bumped` is empty, so the job asks for `ffgithubrunners` [G from GitHub's expression rules, to be checked on the first PR run]. The nightly cache rebuild (`rebuild-caches.yml`) stays `ffgithubrunners`.
- **ci_lane** mints per label: `ffgithubrunners` with its idle target as today, and `ffrelease` when the queue holds a job asking for it. ci_lane already lists queued and running jobs [S] `ci_lane.py:853-858`. The release lane's own rules (grants, `release_tests`) are unchanged.
- **A release pushed during a pause:** its build and its "Test in" jobs ask for `ffrelease`, which a pause never stops, so it ships as usual. PR checks and nightlies wait.
- **Labels must match exactly.** A runner takes a job only when it has all of that job's labels [S] (GitHub routing). So the two pools must never share a label set: no runner may carry both labels.

### 4. Races and failure modes

| Case | What happens |
|---|---|
| Pause at the moment GitHub hands an idle runner a job | Registration-first delete: GitHub refuses, so the job runs. One extra job at most per idle runner [S] `ci_lane.py:1652-1660` |
| Connector restarts | No effect: the pause lives in `~/.config/ffbox/paused.json` on ffwatch's side. The connector only reports it |
| ffwatch restarts | It reads `paused.json` at start; running containers are served (adopted) and minting stays off [G until tested] |
| A runner crashes mid-job | As today: GitHub fails the job, and `reap.sh` sweeps the registration. During a pause nothing re-mints `ffgithubrunners`, and `ffrelease` re-mints only for a queued release job |
| The updater | It drains both lanes while it updates and then lifts its drain files [S] `update_ffbox.sh:545-562,854,1122`. It never touches `paused.json`, so the pause holds through updates. A release in flight waits through an update, as today |
| The workflow change lands while a release run is already queued under the old label | That run's jobs ask for `ffgithubrunners`. So the change merges with no pause on, and a pause is refused while a release run with old labels is queued |
| GitHub-hosted runners are down | versionBump waits, and so does the whole run, as today |

### 5. What it needs on GitHub's side

- **No new permission for FFBox.** Its GitHub App already mints JIT runners and deletes registrations, which need the org "Self-hosted runners: write" permission (classic equivalent `admin:org`) [S] REST docs, `gh.sh:169,187`. Choosing labels at mint time is part of the same call.
- **No org or repo settings**, no runner groups (not available on Free), no repo variables.
- **The `workflow` scope** is needed only to push the change to `.github/workflows/main.yml` [S: GitHub refuses workflow-file updates from tokens without it]. So that PR is pushed from LothDesktop, never BEAST, as you asked. Nothing at run time needs it.
- **Measured:** BEAST's token (`gist`, `read:org`, `repo`) is refused by the org runner APIs with "You must be an org admin or have the runners and runner groups fine-grained permission" [M]. FF Factory reads job state through FFBox, never through these APIs.

## Commands (`ffboxctl`, in the ffbox repo)

| Command | Changes state | What it does |
|---|---|---|
| `status` | no | Units, deployed commit, queue, slots, holds, pause, load, memory, disk, the processes of FFBox's units (names and resources only, no command lines that could hold secrets) |
| `runners` | no | CI runners per label, queued jobs per label, running jobs (ids, workflow, branch) |
| `logs <unit> [--since] [--grep]` | no | The same redaction as the connector's `logs` query |
| `pause [--scope] [--drain] [--until] [--until-release]` / `resume` | yes | As above |
| `hold <lane> --why` / `unhold <lane>` | yes | The existing drain switches, by name (CI, containers) |
| `restart <fffconnector \| ffwatch \| ffbox-update>` | yes | `systemctl restart` of exactly those units |

Every call appends one line to `~/ffbox-state/control.log`: when, who, what, the arguments and the result. `status`
shows the last 20 lines. Output is redacted with FFBox's own secret patterns before it leaves the host.

## The authentication chain

1. **FF Factory.**
   - The `ffbox_control` tool is open to orchestrators, the dispatcher and workers.
   - Commands that change state need `user_asked` and either the caller's own owner identity or an owner's
     `work_id` (`ownerOnlyProblem`, as `set_app_config`'s owner keys).
   - Intake-started work is refused: its text is untrusted.
   - Every call is in the caller's transcript and the request's ledger log.
2. **Portal to daemon:** the existing machine link. An outbound WebSocket from the host to the portal's public URL,
   authenticated with a per-machine token that the portal keeps only as SHA-256.
3. **Daemon to host:**
   - The daemon runs as `fffctl`, a new account that is not FFBox's owner, not in the docker group, and has no other
     sudo.
   - A sudoers rule allows exactly `sudo -n -u <ffbox owner> /opt/ffbox/scripts/ffboxctl *`.
   - `ffboxctl` validates every argument against its own table, so an argument cannot become a command, and refuses
     anything else.
4. **FFBox's own check.** `ffboxctl` also requires `--by fff:<id>` to name a user in FFBox's operators block. This is
   defence in depth: it trusts FF Factory's word, as the dev requests' `fff:<userId>` mapping does today.

## Threat model

| Actor | Today | With this | Mitigation |
|---|---|---|---|
| A hostile container (E0) | Nothing of the control | Nothing | `fffctl` listens on nothing, has its own uid and a `0600` token; no container mounts its folder; `ffboxctl` is reachable only through sudo from `fffctl` |
| FFBox's daemon account taken over (E1) | Controls FFBox | The same; it cannot read `fffctl`'s token | Separate accounts; a different uid reads the token |
| Root on the host (E2) | Everything | Everything, plus the control token, which lets it impersonate the control daemon (not FF Factory itself) | As today; FF Factory's tokens stay off the box (shape A) |
| The portal compromised, or an FF Factory agent misled by injected text | Read-only queries; dev_reply and dev_update effects | The command set: pause, hold, restart three units, read redacted state | Availability only: no secrets in any output, no shell, no code. Commands that change state need an owner's own words; intake work is refused; every call is logged on both sides; Lothsahn sees it in `control.log` |
| A non-owner FF Factory member | Read-only | Read-only | The owner check |
| A network attacker | TLS | TLS plus the token, as the other machines | As the other machines |

**What gets weaker:** the portal gains the power to stop FFBox doing non-release work and to restart three of its
units. **What stays:** containers stay untrusted and cannot reach this; secrets never leave the box; the release lane
cannot be cancelled from here.

## When the connector is down

The control daemon is its own process with its own token and link, so it is unaffected by the connector. If both are
down (the host is down, or its network), nothing in FF Factory can help, and owners use ssh. `ffboxctl` is the same
command over ssh, so the runbook is one line.

## Build order (after agreement; no ffbox master pushes before Build 81 has landed)

1. **ffbox:** `ffboxctl` with `status`, `runners`, `logs`, `pause` and `resume`; `paused.json` read by `schedule`,
   `keep_pool` and `ci_lane`; the updater leaves it alone; `capacity.holds` and `status` report it; tests on the box's
   suite. This is usable over ssh at once. One push, then a check of the box.
2. **Game repo:** the release-run label (one PR off develop). **ffbox:** `ci_lane` per label. One push, then a check.
3. **FF Factory:**
   - Linux support for the daemon in control-only mode (deployed over ssh as a systemd unit of `fffctl`);
   - the `ffbox_control` tool with the owner check;
   - the protocol's control message;
   - tests for the auth check and for pause/resume;
   - `docs/ffbox.md`.
4. **Host setup** (Lothsahn or with him): the `fffctl` account, the sudoers line, and the daemon's install. Then
   `holds`, `unhold`, `restart`, one at a time.
