# Standing agents

A standing agent is a long-lived Claude Code agent with an ongoing job, such as triaging Discord
reports or reviewing PRs. It is defined and managed from the web app, and it sits apart from the
sandboxes: it has no worktree and no Unity. It wakes on a schedule (or when the user presses Run now),
does its job, writes down what it did, and goes back to sleep. When it needs real work done in the
game repo, it asks for a sandbox worker instead of doing the work itself.

The list starts empty. Nothing is seeded or hard-coded: every agent is defined in the UI or through
the orchestrator's tools.

**Every standing agent runs on a machine** (w510, 2026-10-06): its process is a child of that machine's daemon, never
of the portal, which runs only the orchestrators and the dispatcher. `create_standing_agent` and the New standing agent
form require a machine. One from before with no machine keeps its record, history and conversation, but never runs:
a manual run is refused and a scheduled one is recorded as skipped, with the reason. `system_status` names each such
agent, and giving it a machine (`update_standing_agent machine`, or Edit → Runs on) is the way out; moving it starts a
fresh conversation there. This replaces D16 of the portal-only mode (w464), which ran no standing agent at all, not
even one on a machine.

## Definition

Stored in `data/state.json` (`StandingAgent` in `shared/types.ts`), in the portal; only its process runs on the machine.

| field | meaning |
|---|---|
| name | display name; the id is its slug, and the folder is named after the id |
| charter | the agent's standing instructions, appended to its system prompt |
| model | one of `config.models` |
| trigger | `every N minutes`, a 5-field cron expression (host local time), or `manual only` |
| machine | the machine it runs on (required) |
| folder | its working directory on that machine, `<daemon folder>/agents/<id>`; the daemon makes it and seeds `NOTES.md`, the agent's durable state. Not a sandbox |
| enabled | a paused agent keeps its definition, history and conversation but never runs on schedule. Run now still works |
| budget | `perRunUsd`, `perDayUsd` and `maxMinutes` per run (added: a hung run would hold an agent slot forever) |
| tools | tool groups, below |

## Runs

- Each agent owns one Claude session (kind `standing`) for its whole life. A run resumes that
  session with a short `[run]` message (trigger, budget left, "read NOTES.md, do the job, update
  NOTES.md, end with a summary"). When the turn ends, the server stops the process. Between runs
  the agent is asleep and does not count toward its machine's `max_agents`. During a run it does.
- **No overlap.** An agent has at most one pending or active run. A schedule tick that comes due
  while a run is active is recorded as `skipped (previous run still going)`.
- **Limit full.** A due run waits (dashboard: "waiting for an agent slot") until its machine has a free slot, for
  at most 60 minutes or until the next scheduled occurrence, whichever is sooner. It is then
  recorded as `skipped (no free agent slot)`. Standing agents only take free slots; they never stop
  a worker.
- **Schedule.** Interval: the next run is N minutes after the previous one came due. Cron: the next
  match after now. If the server was down past a due time, it runs once on boot (one catch-up, not
  one per missed slot).
- **Budget, hard-enforced.** Each run is its own `query()` process, started with
  `maxBudgetUsd = min(perRunUsd, perDayUsd - spent today)`, so the Claude CLI itself stops the run
  when it crosses the cap (it checks between model calls, so one call can overshoot slightly). The
  server also stops a run whose measured cost reaches the cap, and one that passes `maxMinutes`. A
  run is not started at all when today's budget is spent. "Today" is the host's local date. Costs
  are the SDK's estimates.
- **Messages.** Typing to a standing agent in its panel starts a run with that text attached (same
  budget, overlap and limit rules). If a run is active, the text joins it.
- A server restart marks an active run `interrupted`.

Run history (last 50, per agent) records trigger, start/end, outcome (`ok`, `error`, `budget`,
`timeout`, `stopped`, `skipped`, `interrupted`), cost, and the summary (the final message).

## Tools and guard

Every standing agent gets Read, Glob, Grep, Skill, and Write/Edit **only inside its folder**. It
loads user settings (so the ff-agents / ff-discord plugin skills are available) but no MCP servers
except its own. Permission mode is `bypassPermissions`, bounded by two `PreToolUse` hooks:

1. `sandboxGuard`, the same one workers get: no push to the game repo's master/main, no force push,
   no remote branch deletion, no killing processes, no protected paths (the live checkout, this
   server's code and data).
2. `standingGuard`: Write/Edit only in its own folder; shell commands must be on an allowlist
   that depends on the groups, and may not name another sandbox, the base clone, or use command
   substitution, heredocs or output redirection (write files with the Write tool instead). Paths are
   recognised with a drive letter and, since w467 (change 8), as absolute POSIX paths (`/srv/fff/base`
   in the portal VM). It also keeps Read, Glob, Grep and the shell off FF Factory's secrets and data
   (config.json, data/, the secrets folder, ~/.ssh, Claude's and gh's credentials, a machine daemon's
   daemon.json): [orchestrators.md](orchestrators.md#what-orchestrators-and-standing-agents-may-not-read).

Tool groups (none by default, so the default is read-only on files only):

| group | adds |
|---|---|
| `shell_read` | Bash, limited to read-only commands: `git` log/show/diff/fetch/clone/ls-remote/…, `gh` pr/issue/repo/run view and list, `gh api` GET, plus cat/grep/ls/jq-style utilities |
| `github_comment` | `gh pr comment`, `gh issue comment`, `gh pr review --comment`, and `gh api` POSTs to issue/PR comment and review endpoints. Never approve, request changes, merge, close or edit (implies `shell_read`) |
| `delegate` | `request_delegation` and `my_delegations` (below) |

### Delegation

A standing agent asks for real work with `request_delegation(title, task)`. Since w527 an approved delegation is an
ordinary request in the work ledger ([orchestrators.md](orchestrators.md#requests-and-the-ledger)): it is filed for the
agent's **owner** (`owner`, set to the person who created the agent; agents from before have none and use the system
payer, config `systemPayer`, else the owner), with the task verbatim as its brief and a fixed constraints line
(written by the agent; a PR into develop, never master or main, which its worker does not merge: a person's merge is
the review; anything that spends money, publishes, changes a live setting or releases needs a person). The dispatcher gets it as a normal `[work request]`, with the agent and who
approved it in its first line, and queues, places (LothDesktop, the Macs, BEAST within its caps, by the placement
rules) and starts it like any other. Nothing here picks a sandbox, starts a worker or expires: a request the
dispatcher queued waits for capacity however long it takes, and the ledger cleanup never stalls it
(`stallCandidate`). Its status shows in `list_work` and the dashboard's Requests tab ("from <agent>"), and the agent
sees it with `my_delegations` (the request's status, PRs and last outcome).

How a request is approved:

- **Auto-approve** (per agent, `autoApprove` / the `auto_*` fields of create/update_standing_agent, and the editor):
  within `maxPerRun` and `maxPerDay` (default 3 and 3) a request is filed at once, with no click. `model` / `effort`
  (default opus, high) are passed on to the dispatcher as a suggestion. The owner's orchestrator hears each one
  (`[auto-delegation] "<agent>" filed w12 ...`), to mention to its person. The nightly regression sentry
  (`nightly-regression-sentry`) gets auto-approve on by default (`AUTO_BY_DEFAULT`, server/schedule.ts) unless a
  person set it either way.
- **The person-only gate** (`personOnlyReason`, server/schedule.ts): a request whose title or task asks to spend
  money, publish or post outside, change a setting (app config, a Steam branch, secrets' homes), release or deploy,
  or merge into master waits for a person whatever the rules say. It matches the request's words, so it errs towards
  a click.
- **A person**: the Approve button on the agent's page ("Approve: queue it") files it at once; it never needs a free
  slot. "Approve and start now", and "Start now" on an approved one, make its request urgent and tell the dispatcher
  to start it ahead of the queue (`POST /api/delegations/<id>/bump`). The dispatcher's `approve_delegation` needs a
  request its person asked for in their own words (`work_id`), like `delete_sandbox`; a person's own orchestrator
  has `approve_delegation` too, and it works only in a turn its person started.

**De-dup**: the same agent asking again with the same title while its request is open, or within two days of it
finishing (`DELEGATION_LOOKBACK_MS`), is that request: a log line on it, not a second filing, and the delegation
shows `repeat`. Anything else is filed with the ledger's overlap check, like every filing, and the dispatcher merges
what repeats. The automated sources' caps apply (`workLimits.standing`, 10 an hour and 40 a day by default).

Before w527 the portal picked a target itself: a host sandbox (or one of BEAST's own daemon's) labelled `unused`,
or a whole machine labelled `unused` with no agents and a clean tree, and retried an auto-approved request until
`expiryHours`. It never looked at other machines' sandboxes, so on 2026-10-06 the sentry's four requests (2c70e0fa,
3e15c546, 2fc4dfb9, a99fe7d2) waited "no free target" for hours while three LothDesktop sandboxes sat labelled
`unused`; they were started by hand under w524. The first tick after the update files any request still queued
that way, and links those four to w524 (`DELEGATIONS_HANDLED`, server/standing.ts). `targets`, `expiryHours` and
`exclude` are dropped from saved settings.

## Dashboard and orchestrator

- Sidebar section **Standing agents**: a card per agent with status, next run, and today's spend.
  The agent page shows status, trigger, next run, today's spend vs budget, the last run's result
  and summary, run history, its delegation requests (pending ones: Reject, Approve: queue it, Approve and start now;
  filed ones: their request and its status, and Start now), and the conversation.
  Buttons: Run now, Stop run, Pause / Resume, Edit, Delete (confirms).
- Dispatcher tools (also on `/mcp`): `list_standing_agents`, `create_standing_agent`,
  `update_standing_agent`, `run_standing_agent_now`, `pause_standing_agent`,
  `resume_standing_agent`, `list_delegation_requests`, `approve_delegation` / `reject_delegation`,
  and `delete_standing_agent` (requires `user_asked`). People's own orchestrators have the two lists and
  `approve_delegation` (only in a turn their person started).

## Decisions and changes from the brief

- **No seeded agent**: the example below is documentation only.
- Added `maxMinutes` per run, and "Stop run".
- Folders live in the machine daemon's folder, never in the portal's `data/`: the guard's own-folder exception would
  otherwise unprotect the whole data dir. (Before w510, agents that ran in the portal itself had theirs under
  `<standingRoot>`, by default `<sandboxRoot>/_agents`.)
- The read-only shell is an allowlist, not a denylist. It is a seatbelt like the rest of the guard:
  an agent can still read any file the host user can, and a comment is a way out. Keep charters
  that read untrusted text (Discord, PR bodies) away from `github_comment` unless needed.
- Not in v1: reporting a delegated request's result back into the agent's run automatically (it reads it with
  `my_delegations`), Discord or web tools, per-agent environment/secrets.

## Example charter (documentation only)

A PR reviewer, with trigger `every 30 minutes`, groups `shell_read` + `github_comment`, budget
$3/run and $15/day. It needs `gh auth login` on its machine; comments post as that account.

> Review open, non-draft pull requests on example-org/example-game. Each run: list them with
> `gh pr list -R example-org/example-game --state open --json number,title,headRefOid,isDraft,author`.
> NOTES.md holds a table of PR number to the head SHA you last reviewed; skip PRs whose head is
> unchanged. For each new or updated PR, read `gh pr view` and `gh pr diff`, check the changes
> against the repo's CLAUDE.md rules (determinism, fp math, simulation vs presentation), and write
> one review to a file in your folder. Post it with
> `gh pr comment <n> -R example-org/example-game --body-file <file>`, starting with
> "Automated review (FF Factory)". One comment per head SHA. Never approve, request changes
> or merge. Record the SHA in NOTES.md, and end with one line per PR reviewed.
