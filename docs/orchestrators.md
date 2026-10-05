# Orchestrators: one per person, and a dispatcher

Ben and Lothsahn used to share one orchestrator chat, so each read the other's conversation and could interrupt it.
Now every person has their own orchestrator, and one dispatcher owns everything that changes the machines. People's
orchestrators file work requests with the dispatcher, which checks them against the work already in flight before it
starts anything. The record of every request and what became of it is the work ledger.

## The two kinds

**A person's own orchestrator** (`orchestratorRole: 'personal'`, its `requestedBy` is its person) talks only with that
person. It runs on their own Claude token when config `userClaudeEnv` has one, otherwise on the account
`claudeAccounts.orchestrator` picks (the owner's), and `system_status` says which. Its tools, as listed in
`server/belts.ts` `PERSONAL_TOOLS`:

- read everything: `list_sandboxes`, `list_machines`, `list_branches`, `agent_transcript`, `search_transcripts`,
  `system_status`, `ffbox_activity`, `max_activity`, `list_standing_agents`, `list_delegation_requests`;
- its own `wake_me`, its own timers (`set_timer`, `list_timers`, `update_timer`, `cancel_timer`; [Timers](#timers)), and
  its person's heartbeat (`set_heartbeat`);
- `message_agent`, only to its person's own workers: one they started, or one any of their requests is on (the
  dispatcher started it for the request, sent it the request with `work_id`, or linked it), whoever started it, while
  that request is open, stalled or closed in the last 7 days (w431: a worker Lothsahn started and the dispatcher then
  sent Ben's w426 was refused to Ben, because w426 was stalled; one on Ben's finished w427/w428/w430, because they were
  done). The message carries `[about w426 "title"]` under the sender line, so the worker knows which of the person's
  requests it is about; at most 3 per worker until the person writes again;
- the ledger: `request_work`, `list_work`, `update_work`;
- `message_person`, to another person's own orchestrator ([People to people](#people-to-people)).

It cannot start, stop or change anything else. To get work done it files a request.

**The dispatcher** (`orchestratorRole: 'dispatcher'`) has every other tool, plus `list_work` and `decide_work`. People
do not chat with it; the owner can open its page and write to it. It runs for the system payer (config `systemPayer`,
Ben). It hears work requests, updates to them, capacity news and the host's notices, and answers people only through
the ledger.

Both briefs describe the same world (`worldBrief` in `server/agents.ts`). Its FFBox paragraph is Lothsahn's text,
verbatim (`FFBOX_BRIEF`): what FFBox is, that it owns #bug-reports and dev_bug_reports, and that the ffbox repo can be
changed through workers, who push straight to its master one change at a time because a push goes live on the box within
about five minutes. The longer version is [ffbox.md](ffbox.md). After it, the paragraph names `ffbox_activity`'s views,
the live ones too (`config`, `board_log`, `status`, `conversation` with `id`) and the "Last known, from <time>"
fallback, and says that a copy of the tool's schema earlier in a resumed chat may list fewer views and is out of date.
`ffbox_activity` stays read-only.

Both are sessions of kind `orchestrator`, so neither takes an agent slot, and both keep the orchestrator's limits: no
shell, no web tools, `Read`/`Glob`/`Grep` on the base clone, and `Write`/`Edit` only in their own memory folder
([Memory](#memory)). Their briefs share one description of the world
(`worldBrief` in `server/agents.ts`); the dispatcher's is the old shared orchestrator's, edited for a chat nobody
writes to.

## Requests and the ledger

`request_work {title, brief, priority, constraints, related_ids, attachments}` files a request (`w12`). `attachments`
are ids of files the person attached to their message (saves, bug-report zips, logs): the request keeps them, and every
worker started for it gets a copy in its `Inbox/` ([attachments.md](attachments.md)). Before the dispatcher sees it,
the server (`server/work.ts`) does three things:

1. **Repeats.** An open request of the same person with the same title (ignoring case and punctuation) is returned
   instead of a new one, and the new text goes into its log.
2. **Overlaps.** It pulls keys out of the request (specs like `098`, PRs named as such, other `#N` references,
   branch-like names of the branches checked out anywhere, and the ids in `related_ids`) and compares it with open requests and those closed in the last 48 hours, live and
   recent workers wherever they run (their title, and the branch and open PR of their sandbox, this host's or a
   machine's, or of the machine's main clone), pending delegation requests, and commits on the base branch in the last
   48 hours. A shared request, worker, PR or branch scores 1; a shared spec or `#N` with a similar title scores 0.8,
   without one 0.5; otherwise title similarity. 0.8 and over is strong. The person's orchestrator gets the overlaps at
   once, in the tool's answer.
3. **Limits.** Below.

Requests also come from the intake ([intake.md](intake.md)): Discord bug reports, trusted people's requests to Max
and FFBox's work, each with its source, its triage (an obvious bug, or it needs a human) and, until a reviewer approves
it, `approval: pending`, which keeps it from the dispatcher and makes `start_agent` refuse it. Work started from the
dashboard, over `/mcp` or for a delegation is recorded as an active request too, so the ledger shows all work.

The dispatcher then does one of these for each request:

| decision | how | status |
|---|---|---|
| start it | `start_agent` with `work_id`, or `message_agent` with `work_id` to a worker already on it | `active` |
| merge it | `decide_work merge` into the open request it repeats; its people join that one | `merged` |
| link it | `decide_work link` to workers already doing it | `active` |
| queue it | `decide_work queue`, saying what it waits for | `queued` |
| ask | `decide_work ask`, at most 3 questions per request | `question` |
| reject it, or close it | `decide_work reject` / `done`, saying why | `rejected` / `done` |

Where it runs is the dispatcher's choice: `list_sandboxes` starts with each computer's room (BUSY or ROOM n%, live
agents, free sandboxes, RAM, editors) and names the computer the next new game-repo work goes to, and `start_agent` or
`create_sandbox` that place it elsewhere say so (w416; docs/machines.md, "Placing work"). Game-repo work is spread
between BEAST and LothDesktop by room; BEAST keeps only what needs it.

`start_agent` refuses a request with a strong overlap still in flight (a commit only informs), or one that already has a
live worker, unless `override_duplicate` says what is different. `work_id` is the dispatcher's alone. A worker started
for a request runs for the person who filed it, on their account. The requester's orchestrator can add a note (which
answers a question), change the priority, close the request, or reopen it within 7 days (`update_work`). Closing is the
filer's: the others still on the request hear it. Someone whose request was merged into it only leaves it.

**Owners close each other's requests when asked** (w402, Lothsahn: "ben and I can close each other's requests if we
explicitly ask"). A person with the `owner` role (docs/identity.md; Ben and Lothsahn today) may have their own
orchestrator close (done or cancelled) or reopen **another person's** request with `update_work`
(`Orchestrators.closeForOther`, `server/orchestrators.ts`), under the guard approving an intake request uses:

- only in a turn the owner started with their own message; a turn a harness notice, a worker, a standing agent or
  relayed FFBox or Discord text started is refused ("only Lothsahn, in their own words in this turn, closes or reopens
  Ben's request w234: ask them");
- only close or reopen, and only with a note saying why. A note alone or a priority change on someone else's request
  stays refused: those are its people's to give (a note can answer the dispatcher's question for them);
- the request's log says `closed as done by Lothsahn (Ben's request), in Lothsahn's own turn: <note>` (or cancelled,
  reopened), and its people's orchestrators get a `[dispatch]` line naming who did it and why. A cancel or a reopen
  reaches the dispatcher as a `[work update]`, as their own would. It does not change whose request it is, or
  `humanAsked`: another owner's word is not its people's own.

A member keeps the rule above: their own requests only ("w234 is Ben's request, not X's; only an owner closes or
reopens another person's request").

The ledger is `data/work.json`: every open request and the newest 300 closed ones (stalled ones are kept like open
ones). The page gets the open ones, the stalled ones and those closed in the last 3 days.

### What a request is doing now

`active` only says a worker was given the request once. Beside its status, every open or stalled request shows what it
is doing **now** (w418, asked by Lothsahn: "show stalled requests as Stalled instead of active, so we can see what
workers are working on vs which are waiting on input"). It is derived live from its workers and its own fields
(`shared/workState.ts` `workLive`), never stored, and changes nothing: the first that applies wins.

| state | when | the line says |
|---|---|---|
| **Working** | a worker it serves is `running` or `starting` (in a long command too), or FFBox runs it (`ffbox` sent or accepted) | which worker, and the tool it has been in since when |
| **Waiting on input** | an intake approval is pending, the dispatcher's question or a design question is open, a worker it serves waits for a permission, or a worker it serves stopped asking for a decision (its last report ends asking a person to decide, or with a question) | what, and on whom: "a reviewer", the requester, the design question's people, the worker's person |
| **Queued** | not dispatched yet (`new`), queued by the dispatcher (`queued`), or a message to its worker waits for a free agent slot (the send queue; list_work only, the page does not have the queue) | which |
| **Merged, follow-up pending** | its PRs merged, none is open, and it is still open | the cleanup's own reason ("still open: its brief asks for a step after the merge"), or that the cleanup has not looked yet |
| **Stalled** | anything else: nothing works on it and nothing waits on a person, as soon as that is true | why: the cleanup's stall reason, an open PR nobody is on, its worker moved on to another request, finished its turn or stopped (and when), or no worker was ever started |

**A worker on several requests works only on the one it was last given** (and those linked to it since). Each request
records when each worker was last given it (`links`: `sent` by `start_agent`/`message_agent` with its `work_id`,
`linked` by `decide_work link`). A worker's current turn serves the request it was last *sent*, plus any *linked* to it
after that (small reports sharing one worker). For links made before w418, the request's creation time stands in, so a
worker that moved on to a newer request (w342's worker on w414) no longer makes the old one look worked on.

**The cleanup still decides; this only shows.** The stored status, and the cleanup's own `stalled` with its reason and
its 24 hours ([Ledger cleanup](#ledger-cleanup)), are unchanged and still decide what is closed, resumed or stalled.
The live state can say Stalled for a request whose status is `active` (a day before the cleanup would stall it), and
Working for one the cleanup stalled whose worker picked it up again.

Where it shows: `list_work` puts it after the status (`- w12 [active] Stalled (ab12 stopped 3 d ago,
nothing waits on a person): "…"`), closes the list with the counts (`Now: 3 working, 2 waiting on input, 4 stalled.`),
and takes `state`, one of working, waiting, queued, followup or stalled or a list of them (`["working", "waiting"]`), to
list only those. The Dispatcher page's Requests tab, and the Intake tab's "In the ledger" list, have a toggle chip per
state with its count above the list: any number can be on at once, and the list shows the requests in any of them;
"All" or "Clear" turns them off. Each list's choice is kept in the browser (localStorage) across reloads (Lothsahn: "I'd
like to be able to select multiple types"). Each row's state and reason follow its workers live.

## Pull requests

Each request is linked to the pull requests its workers open (`WorkItem.prs`: repo, number, state, merge commit, and
`via`, the evidence). A PR belongs to a request only on strong evidence (`prsOf`, `server/ledgerRules.ts`):

- its description has a line `Request: w293` (the brief of every worker started with a `work_id` asks for it:
  `requestLineRule`, `server/work.ts`), or `Part of: w293` for a PR that is one step of the request (below); or
- the request's own worker opened it: a `gh pr create` in the worker's transcript printed its URL, after the request was
  filed, while the worker was on this request (a worker that did several requests in a row owns each PR for the latest
  request filed by the time it ran the command, `ownerAt`); or
- its head branch is the request's own branch (an intake request's `ffbox/...`).

It is **never** linked from related ids, from a PR number the brief or a worker's report mentions, or from a worker or
sandbox the request merely shares, and never when the PR merged before the request was filed. A PR whose description says it
is for another request is not this one's. Links made before these rules (no `via`) are dropped unless the rules find them
again, and an automatic close whose closing PR no longer qualifies is reopened by the next pass (active when a worker is on
it, else new), with a line in its log and a note to its person (w340: w339 was closed on #988, an earlier request's PR), and a
`ledger cleanup: reopened <id>` line in the server log; the first pass after a start also logs how many closes it checked
(after the f4ce1cd deploy it reopened 42, w312 among them, and the log said nothing). A request a person, the dispatcher, a worker's marker or the intake
closes or reopens loses its `autoClosed` mark, its "closed automatically" outcome and any PR link made before the strict
rules (`settleByHand`), and the re-check skips (and clears) a request whose log shows such a close after the cleanup's own:
a person's close is final (w370: w50 was closed by hand at 06:33 and reopened by the re-check at 06:34). The PRs show on
the request in the Requests tab and in `list_work`. The repos asked are the game repo's and this app's own (from their
`origin`), or exactly `ledger.cleanup.repos` when that is set; the data comes from `gh pr list` (the 200 newest of each, and
`gh pr view` for a linked open PR older than that). When gh cannot answer, the PR rules wait and the rest of the cleanup still runs.

**When a linked PR merges** (checked every 5 minutes, `LedgerSweep.checkPrs`, `server/ledgerSweep.ts`), the request
closes as done, logging "merged as #N (sha) on date", when all of this holds:

- none of its linked PRs is still open (the log says "#N merged; still open: PR #M is open" otherwise);
- none of its workers has a turn running (a request with a running worker is never touched);
- nothing is left after the merge (`afterMergeReason`, `server/ledgerRules.ts`). It stays open, with the log line
  "#N merged; still open: …", for: a **release** (its title or brief says release, patch notes or `ci-release`: it ends
  when the build is live and the patch notes are posted, which the worker's final report must say with the notes link); a
  brief that asks for a step after the merge (a 2-peer check, an audit, "after the merge, verify"); a brief that plans
  several PRs ("PR1 data, PR2 presentation"); a worker's last report that says more is coming; or an open question.
- the last PR to merge does not say `Part of: <id>` (`partOfReason`, w424). A worker marks a PR that is only one step of
  its request that way (a fix the real work needs first); the request stays open ("#N is one step of it … more
  follows") until a `Request:` PR of it merges, its worker reports `DONE: <id>`, or the follow-up below asks.

A worker's last report counts by its end, where workers write `<id>: still open: …` or `DONE: <id>`: `lastResult` keeps
a long report's first 400 and last 800 characters (`reportClip`, `server/sessions.ts`). It used to keep only the first
1200, so on 2026-10-05 w424 was closed twice, on #99 and #100, while its worker's reports ended "w424: still open".

A PR **closed without merging** never closes the request: the log says so once, and its person's orchestrator hears it
when no other PR is open. Intake requests that wait for a reviewer are never closed here (the intake's own rule is in
[intake.md](intake.md), "Closed when it merged").

## Ledger cleanup

What the page and `list_work` show as a request's live state ([What a request is doing now](#what-a-request-is-doing-now))
is read from the same facts but never feeds the cleanup: a request can show Stalled at once and still be stalled by the
cleanup only after its 24 quiet hours.

Every `ledger.cleanup.everyHours` hours (config.json; default 4, 1 to 168; `enabled` defaults to true) and on demand
(the owner's **Clean up now** on the Requests tab, `POST /api/ledger/cleanup`), `LedgerSweep.run` goes through every
open or stalled request. The first full pass after a start comes 10 minutes after it (or `everyHours` after the last one).
A full pass that finds the 5-minute pull-request pass still running waits for it (up to 10 minutes) instead of skipping:
until w363 it skipped, so no full pass ever completed (`lastRunAt` was never written in `data/ledger.json`) and nothing
below was ever applied. Each close, resume and stall is a `ledger cleanup: <closed|resumed|stalled> <id> (<people>)` line in
the server log, and each full pass ends with `ledger cleanup: full pass: <summary>`. **A request with a running worker (running, starting or waiting for a permission) is never
touched**, and nothing waiting for a person (an open question, an intake request awaiting approval) is closed or
stalled. Ben's requests are included. In this order, the first that fits applies:

1. **Merged.** The pull-request rule above for every request, and the intake's merged-branch rule for intake requests.
2. **Delivered.** A request whose worker's final report (`lastResult`, at least an hour old) states plainly that the work
   is done ("All done", "is delivered", "nothing more to do", "fully merged to develop, so I'm idle", "is fixed and merged into
   develop", "nothing is open or pending") and says nothing is left, waiting or asked, with no open PR
   and no step after the merge, closes as done with that report quoted. A release's report must also link the patch
   notes and say it is live. When the report is not clear, nothing closes.
3. **Cut off.** A worker that stopped on a usage or rate limit (also one whose turn simply ended with Claude's "You've hit
   your session/weekly limit" as its whole result), an app restart (its turn was still open) or a refused tool
   and never resumed. A limit or restart is resumed once (a message to the worker, recorded in `resumedBy`): a limit only
   when the account it ran on has room again (no plan meter at 90% or more; unknown counts as no). A refused tool, a
   limit that has not reset, and a worker cut off again after its one resume make the request **stalled** with the reason.
4. **Merged, asked.** A request whose PRs all merged but which stays open for a step after the merge (rule 1's reason:
   a check or audit its brief asks for, a release's notes, a plan of PRs, a worker saying more is coming), with no word
   about it for **6 hours** (a report from a worker still on it, the merge, or the last question) gets one message to its
   most recent worker: "Is wNNN done? Reply `DONE: wNNN`, or say what's left" (w419). At most one a day per request
   (`WorkItem.followUp`). Its reply's `DONE: wNNN` closes it (below); any other reply stays as its latest line. A worker
   now running on **another** request is still asked (the message waits until its turn ends); nothing else touches a
   request with a running worker. With no worker left to ask, the request is **stalled** as "follow-up unconfirmed".
   Six hours: the pass runs every 4, and the steps that follow a merge (a paired audit, the first hour of a release, a
   nightly comparison) ran up to about 2.5 hours each in w342, so a request still quiet after 6 is asked at most about 10
   hours after its merge, and one whose worker is still busy on its step is not.
5. **Superseded.** A request nothing has touched for 24 hours whose work a finished request covers (a newer finished
   release, or a finished request that overlaps it strongly) is stalled with "probably superseded by w…".
6. **Stalled.** A new, queued or active request with no running worker and no activity for 24 hours (its last update, and
   its workers' last activity) is stalled with the reason: no worker ever started, or its last worker ended and its report
   is not clear.

**`DONE: wNNN`, the worker's word that a request is finished** (w419, asked by Lothsahn after w342 stayed open with its
work done). Every worker brief for a request ends with the rule (`doneRule`, `server/work.ts`): when every step of a
request is finished, the steps after the merge included, the worker ends its report with a line `DONE: wNNN` (one line
per request, several allowed; a mention inside a sentence is not one). At the end of that turn the ledger closes the
request as done with the report's first line as its note, logs it, and tells its people (`[ledger] w342 … closed as
done`). It counts only from one of the request's own workers, and it is refused, with the reason sent back to the
worker (once per reason in 6 hours) and logged, while a PR of the request is still open, for a release whose report
does not say it is live and link the posted notes, for a brief that asks for a step after the merge when the report
does not say how it went (an audit, a check, a 2-peer run, a nightly…), or for a brief that plans several PRs when fewer
than two merged and the report does not say they all did (`doneProblem`, `server/ledgerRules.ts`). A request already
closed by hand stays closed (w370), and an owner's close of someone else's request (w402) is untouched.

**A request with several workers closes on the last one's DONE** (w434, after w428 on 2026-10-05: worker 2092b20c's DONE,
after only its hardware read, closed the request while the placement work it was for was still unpushed). Each DONE
records that worker's part (`WorkItem.done`: session id, when, the report's first line), and the request closes only
once no other worker is still on it (`stillOn`, `server/orchestrators.ts`): every worker linked to it has said DONE,
ended (stopped, errored or gone), or moved on to newer work (it no longer serves the request, `servedBy`). Until then
the worker is told its part is recorded and who is still on it, and the log says so. When the last worker still on it
ends without a DONE (`workerEnded`, called as its process stops), the request closes on the latest DONE's report, unless
`doneProblem` finds something missing in it; then it stays open and the log says why. The other choice, only the
request's first ("main") worker may close it, was not taken: at w428 the worker that closed it may well have been the
first one started, and a request handed from worker to worker has no single main one, while who is still on it is
already in the ledger (links, `servedBy`, session state).

**The wrap-up** (w419). When the dispatcher sends a worker work for a request (`message_agent` with `work_id`) and the
worker's current turn is on other requests (`servedBy`, [What a request is doing now](#what-a-request-is-doing-now)),
the message starts with `[wrap-up]`: for each request it was on, end the reply with `DONE: <id>`, or one line
`<id>: still open: <what>`, then carry on with the new work. Those requests' logs say so; the worker's next report closes
them on a DONE, or its line naming the request becomes that request's log entry and latest line. Nothing waits on it.

`scripts/ledger-dry-run.ts <copy of data>` prints what rules 1 and 4 would do now (close, ask, stall, or wait), changing
nothing.

**Stalled** is a status of its own (`WorkItem.stalled`: kind, reason, when): out of the open lists, behind the "N stalled"
filter on the Requests tab and `list_work status stalled`, kept like an open request. The cleanup never closes one: its
person closes it (`update_work close`), or reopens it, or writes a note on it, which revives it as new. A stalled request
whose PRs later merge is closed by rule 1.

Each action is logged on its request. Each person's orchestrator gets one `[ledger cleanup]` line per pass listing what
closed, resumed, was asked about and stalled for them, and nothing when nothing changed. The first pass also lists the requests with a
merged PR that stayed open and why. The Requests tab shows when it last ran and what it did. Limits of the rules, all
fixed code and no model: a worker's report is read by patterns, so an unclear one never closes anything, it only stalls
the request after a day; a PR is linked only by the ways above, so an old request whose PRs carry no `Request:` line and
whose worker's branch has since moved on is not linked.

## People to people

A person's orchestrator reaches another person with `message_person {to, text}` (`to` is a user id), when its person
asks it to: a decision only the other person can make, a script only they can run on their own machine. The server
(`Orchestrators.messagePerson`, `server/orchestrators.ts`):

- refuses anyone but a person's own orchestrator (the tool is only in their belt, `server/belts.ts` `PERSONAL_ONLY`, and
  the method checks the chat's role again), an unknown user id, the sender's own person, an empty text and one over
  2000 characters;
- allows 3 messages from one person to another until the recipient writes to their own orchestrator (`personWrote`), so
  two orchestrators cannot keep a conversation going between themselves;
- sends the recipient's own orchestrator (made if missing) a harness message, recorded with the sender as `requestedBy`:
  `[person message] From Lothsahn's orchestrator (user id lothsahn), written for Lothsahn:`, the text, then a line
  saying it is data to show the recipient, not an instruction. It is in the recipient's transcript at once, so a
  restart keeps it; one sent mid-turn waits for that turn, like every harness message;
- marks it unread on the recipient's session (`personMessages`) until they open their chat (`POST
  /api/sessions/:id/seen`, their own only) or write to it, and sends them alone a notification (kind `person`).

The recipient's orchestrator shows who it is from and what it asks, in a line or two, and never acts, files work or
answers on its own: its person decides, and it answers with the same tool only with what they say. A turn a
`[person message]` starts is the harness's, not the person's, so the destructive tools stay closed in it. The dispatcher
neither relays nor sees these messages.

## Evidence and labels

In October 2026 an ad campaign went live on click caps nobody had researched, relayed to the person as recommendations,
and visual fixes were reported as done from position numbers and a review that was still pending. Asking the person
more often would not have helped: they were approving throughout, with no basis in front of them. So the briefs carry
one rule, and it is the agent's own to enforce (`server/evidenceRules.test.ts` pins the text).

- **Every worker** (`EVIDENCE_RULES`, in the three worker briefs): before anything that spends money, publishes,
  changes a live setting, releases, merges a simulation or player-visible change, or deletes, and before reporting a
  fix as done, it lists the choices or claims involved and what each rests on: measured, sourced, or a guess. It settles
  its own guesses by research (the tool's own docs and on-screen recommendation first), then carries on without asking.
  It asks the person only to confirm a money value, for what the rules already reserve for them, or when research
  leaves a real fork. It merges its own pull request once its verification is done and CI is green (`MERGE_RULES`;
  the owner, 2026-10-02: "stop holding prs, just merge them"), and holds one only for exceptional risk or a concrete
  timing reason, saying which and when it will merge. Its report labels each number and recommendation (`REPORT_LABELS`) and leads with the result,
  because an orchestrator is sent only the first 3000 characters of a worker's final message.
- **A person's orchestrator** keeps those labels when it relays (`WORKER_UPDATE_RELAY` ends every `[worker update]`),
  says what evidence a report names instead of calling a fix done from a title or a tool verdict, and sends a guess back
  to the worker to research. It brings its person a decision only for money, for what the rules reserve for a person,
  or for a fork research could not settle. Its briefs for consequential work list the decisions the work must settle.
- **The dispatcher** carries that list into the worker's brief, and uses `decide_work ask` only for what the requester
  alone can answer. For both orchestrators done means merged: no brief ends at an open PR waiting for a person.

One rule keeps its hold: a task a standing agent delegated is delivered as a pull request and never merged by its
worker (`server/standing.ts`, `startDelegated`). Its text may come from outside the team, and a person's merge is the
review.

The full rule, the checklists (visual changes, merges, releases) and the dated lessons are the `evidence-gate` skill of
the `ff-agents` plugin (repo final-factory-agents). The briefs hold only what every agent needs without loading it.

**Ids come with words** (Ben, 2026-10-03). Every worker's and orchestrator's brief, the dispatcher's brief and the
relay of worker updates tell the agent to say what each id is, every time it appears in something a person reads: "w293
(stopping people from chatting with the dispatcher)", "PR #972 (the fix for lost saves on rejoin)", a commit, a worker or
session id, a sandbox name. The same rule is in the ff-agents `evidence-gate` skill (`lessons/say-what-an-id-is.md`).

## Memory

Each orchestrator has a memory folder of its own: `data/orchestrator-memory/person-<user id>` for a person's (Ben's,
Lothsahn's, anyone's), `data/orchestrator-memory/dispatcher` for the dispatcher (config `orchestrator.memoryRoot` moves
the root). `memoryDirFor` (`server/orchestratorMemory.ts`) makes it when missing. It is Claude Code's auto memory,
pointed there with `settings.autoMemoryDirectory`: the CLI loads its `MEMORY.md` index into every conversation's
context and names the folder in its prompt, so what an orchestrator saves survives restarts and fresh conversations,
and every person's orchestrator has its own though they share the base clone as their working directory. The brief
repeats the folder and the rules.

Orchestrators got `Write` and `Edit` for it, and stay read-only on everything else. A PreToolUse hook (`memoryGuard`)
decides every write, and a hook's refusal holds in every permission mode:

- **Where:** only a Markdown (`.md`) file inside its own folder, after resolving `..`, symlinks and junctions (its real
  path must stay inside the folder's real path), with Windows' path rules (case, both slashes). Refused: the repo,
  `config.json`, the rest of `data/`, other orchestrators' folders, relative paths, links and hard links, UNC and
  `\\?\`/`\\.\` paths, alternate data streams (`MEMORY.md:x`), names ending in a dot or space, device names.
- **What:** no secrets, gitleaks-style: Anthropic, GitHub, AWS, Google, Slack and npm tokens, FF Factory connector
  tokens, Discord bot tokens, private keys, and a password or key assigned a long value.
- **When:** only in a turn its person started with a message of their own (the dispatcher has none: nobody writes to
  it, so it never writes memory in a turn of its own). Orchestrators read text agents wrote (`[worker update]`, relayed Discord and FFBox reports); a harness turn
  must not be able to plant an instruction that every later conversation loads.

### Memory in a private repository

The memory holds one person's preferences, in their words, so it does not belong in a public repository; and a folder
in the app's data on one machine is not versioned. So when the memory root is itself a git repository, the app commits
what changed there and pushes it (`server/memoryGit.ts`, on every backup pass: at startup and every 10 minutes).

- **Private only.** It pushes only to an `origin` GitHub reports as private (`gh api repos/<owner>/<name>`, with the
  machine's own `gh` login). To a public remote, to one that is not on GitHub, or when GitHub cannot be asked, it
  commits here and does not push, and the log says why once. What waited goes out on a later pass.
- **Never into another repository.** The root must be the top of its own repository. The default root is a folder of
  the app's checkout, and the app's repository never gets memory commits.
- **No secrets.** The write guard already refuses them; a Markdown file that holds one anyway is left out of the commit
  and named in the log. Only `.md` files are committed.
- **Whose commits.** The repository's own `user.name` and `user.email` when it has them, else the app's public identity
  (`publicGitIdentity`), never this machine's global identity.
- It never pulls, merges or force-pushes. One machine owns a memory root; a push that is refused stays local and says so.

To switch it on (the owner does this once; nothing in config changes):

```sh
cd <data>/orchestrator-memory          # or wherever orchestrator.memoryRoot points
git init -b main
git remote add origin https://github.com/<owner>/<a private repository>.git
```

The next backup pass makes the first commit and pushes it. The crash backup beside it (`<root>.backup`) keeps working
and leaves `.git` out. General rules about how to work do not belong in this repository either: they go to the harness
repositories by pull request, where workers and forks can read them.

The folder sits in `data/`, which workers' guard already protects (`server/guard.ts`), so no worker can write an
orchestrator's memory either. Workers and standing agents are unchanged. Reading stays as before: an orchestrator can
read any file, other orchestrators' memory included.

**What belongs there, and what does not.** The folder is for one person's preferences and for pointers. A rule about
how to work that every agent should follow does not stay in it, because no worker and no fork can read it: the
orchestrator keeps a one-line pointer, files a request, a worker adds the rule to the harness repo by pull request (the
`ff-agents` `publish-skills` skill; working rules go under `evidence-gate/lessons`), and the person approves. The brief
says so (`memoryBrief`).

## What orchestrators and standing agents may not read

They read the repo, their own memory or folder, and what they are handed; never FF Factory's own secrets or data (w467,
change 7 of [portal-on-ffbox-host.md](portal-on-ffbox-host.md)). A prompt injection relayed into one (a worker's report,
a Discord thread) could otherwise read a token and pass it on in a tool call. A PreToolUse hook (`secretReadGuard`,
`server/secretGuard.ts`; for standing agents inside `standingGuard`) refuses `Read`, `NotebookRead`, `LS`, `Grep` and
`Glob` calls, and a standing agent's shell words, that reach:

- `config.json` and its saved versions (`config.json.prev`, `.1`…), where `FFSB_CONFIG` puts it and beside the app;
- `data/`, apart from an orchestrator's **own** memory folder and `data/attachments` (the files people attached, which
  orchestrators are handed and read); other orchestrators' memory, transcripts, the ledger and state stay closed;
- the secrets folder (`<app>/secrets`, and the portal VM's `/srv/fff/secrets` beside its config folder) and the files
  config `claudeTokenFile` and `anthropicApiKeyFile` name (their whole folder when it is called `secrets`);
- FFBox's ffdiscord config and secrets (`FFBOX_CONFIG_DIR`, `FFBOX_SECRETS`);
- the home secrets of the computer the agent runs on: `~/.ssh`, `~/.claude` and `~/.claude.json` (Claude's
  credentials), `CLAUDE_CONFIG_DIR`, `~/.config/gh` and `%APPDATA%\GitHub CLI` (gh's token), `~/.git-credentials`. A
  standing agent on a machine has its daemon's `daemon.json` and `secrets` added.

A search may not start above one of them either: `Grep` of the app folder, the home folder or a drive root would read
them, so it is refused with the reason; the repo and the agent's own folders search as before. Paths follow the
platform the agent runs on: on Windows without case, with `/c/x` (Git Bash) read as `c:/x`, and UNC and `\\?\` paths
refused; on Linux as they are. Where a path really leads counts too (a link in the repo to `config.json` is refused).
Writes stay `memoryGuard`'s (orchestrators) and `standingGuard`'s (standing agents).

## Timers

Lothsahn (w362): "give yourself the ability to set timers in the FF Factory harness itself, so you don't have to keep
reminding yourself to do things in the chat." `wake_me` is one pending, one-off check-in that a person's message cancels.
A timer is a standing job (`server/timers.ts`):

- **Tools**, for each personal orchestrator and the dispatcher (a remote client's go to its person's own orchestrator):
  `set_timer {title, note, schedule, jitter_minutes?, until?, max_fires?, skip_if_busy?}` answers its id;
  `list_timers`; `update_timer {id, …}` (any field, or `enabled` false to pause and true to resume, counting on from now
  with nothing owed for the pause); `cancel_timer {id}`. `schedule` is one of `at` (once, an ISO time), `every_minutes`
  (at least 5) or `daily` ("HH:MM", with an optional IANA `tz`, default the server's).
- **Kept** in `data/timers.json` through the crash-safe writer (`server/durable.ts`), so a restart loses none. A person's
  message does not touch a timer (it still cancels `wake_me`); a timer stops only by `cancel_timer`, a pause, its `until`,
  its `max_fires`, its one fire, or its person in the UI. "New conversation" keeps them: they move to the new session
  (`Timers.rehome`).
- **Firing.** A tick every 30 s marks each due timer and moves it on. The fire is delivered as the harness's message,
  `[timer <id> "<title>"] <note>`, waking the orchestrator when it is idle; mid-turn, it waits for the turn's end
  (`turnEnd`) and is never dropped. Timers due together go in one message. A fire that comes while one still waits joins
  it ("fired 3 times since it was last delivered"). What came due while FF Factory was down goes once at startup, with
  the count ("5 fire(s) missed while FF Factory was down"), and the next fire is set from now, not a burst. With
  `skip_if_busy`, a fire during a turn is skipped instead.
- **Caps, and why.** 20 active timers per orchestrator (standing jobs are a handful; more is a loop). Every N minutes
  at least 5 (anything faster belongs in code, not a model's turn). 96 timer messages per orchestrator in any 24 hours,
  one every 15 minutes all day: messages are turns, which is what costs tokens, and coalescing means one message per
  turn whatever is due. Past the budget, fires wait, coalesced, until a message fits the window, and that message says
  so. A runaway timer costs at most 96 short turns a day. `TIMER_LIMITS` in `server/timers.ts`.
- **No authority.** The message is `system`, so the turn is not a person's (`turnFrom`): the dispatcher's destructive
  and admin tools refuse it, as do approvals, and a personal orchestrator's per-message budgets do not reset.
- **Who sees them.** Only the owning orchestrator (its tools take only its own ids) and, in the UI, its person: the
  Timers button in your chat's header, and the dispatcher's for owners (`GET /api/timers/<orchestrator id>`, `POST
  /api/timers/<orchestrator id>/<timer id> {action: pause|resume|cancel}`, guarded like writing to that chat). It lists
  each timer's schedule, next and last fire, state and note, and the day's messages against the budget.

## Where messages go

| message | to |
|---|---|
| `[work request]`, `[work update]` | the dispatcher, gathered for 1.5 s per person |
| `[dispatch]` (a decision) | the orchestrators of the people the request is for; a question only to its filer |
| `[worker update]` (a turn an orchestrator started ended, or a permission is waiting) | the orchestrators of the people the worker works for: its requests' requesters, else whoever started it, else the system payer. The ledger records the worker's last line; the dispatcher is not woken |
| `[ledger]` | the dispatcher: after a restart or a fresh conversation, the requests still waiting (what it had not answered died with its process); and when requests are queued and a worker ends a turn, after 30 s of quiet, at least 2 minutes apart and at most 20 an hour (a wake that comes too soon waits) |
| a failed worker of an open request | the dispatcher, as a `[work update]` |
| `[standing agent]`, `[auto-delegation]` | the orchestrator of the person the run was for (the system payer for a scheduled run) |
| `[unity blocked]` | the dispatcher, and the people whose workers are in that sandbox |
| `[app restarted]`, `[machines]`, `[unity]`, `[host]`, the orchestrator inbox | the dispatcher. A person's orchestrator cut off mid-turn by a restart is told to pick its turn up again |
| `[heartbeat]` | each person's own orchestrator, with that person's busy workers, when they turned it on |
| `[timer <id> "<title>"]` | the orchestrator that set the timer ([Timers](#timers)): after its current turn, coalesced |
| `[person message]` | the recipient's own orchestrator (message_person), and a notification to the recipient alone |
| `[work request]` marked intake | the dispatcher, once approved (by a reviewer, or an auto-approve rule for an obvious bug), gathered a minute at a time ([intake.md](intake.md)) |
| `[intake question]` | the reviewers' own orchestrators, when a worker on an intake request stops at a design decision |
| push notifications and in-page notices | a person's own orchestrator's only to that person; a worker's finished turn to the people it works for; the dispatcher's turns to nobody, its questions and errors to the owner |

`/mcp` `ask_orchestrator` and `orchestrator_transcript` talk to the key's person's own orchestrator.

## Agent limits and idle workers

**The limits count agents mid-turn, nothing else** (w384, 2026-10-04: a follow-up to an idle worker was refused with
"already 6 agents running" while six idle workers held every slot). `limits.maxSessions` (this host), and a machine's
`max_agents` (main clone), `max_sandbox_agents` (all its sandboxes) and `max_agents_per_sandbox`, count sessions that are
running, starting or waiting for a permission answer (`isMidTurn`, `server/sessions.ts`). An idle session, its process up
or not, takes no slot. Orchestrators never count. The Unity editor limits are unchanged.

- **A message never bounces off a full limit.** When every running slot of its place is busy, `SessionManager.send`
  queues the message (and `start_agent`'s first prompt) in `data/send-queue.json`, which survives a restart, and delivers
  it, in order, when a turn ends or a process goes (and every 30 s). A message to a session that is mid-turn joins its turn
  at once, and a later message to a session with one waiting queues behind it. `message_agent` and `start_agent` say
  "Queued, not refused: …" with the reason. The host guard (disk, RAM, the sandbox drive) still refuses a new process.
- **Idle processes are capped by stopping, not refusing.** An idle claude process holds memory: measured on BEAST
  (2026-10-04), 100-300 MB resident and 450-650 MB committed each. Before a new process starts on this host with
  `limits.maxSessions` + `limits.maxIdleAgents` (default 6) processes up, the oldest idle one that nothing protects is
  stopped (`SessionManager.makeRoom`).
- **Idle finished workers are stopped** (`Agents.reapIdle`, every 5 minutes): an idle worker whose requests are all
  closed, whose requests moved to another worker, or that has been idle for an hour (`IDLE_REAP_MS`). An hour because a
  follow-up within it reuses the conversation's cached prompt (the hour-long prompt cache); after that a resumed session
  costs the same, so the process only holds memory.
- **What keeps an idle worker's process** (`Agents.keepIdle`, for both): mid-turn, unanswered messages or background
  tasks, a pending permission, a pending `wake_me`, a queued message, or a sandbox (host or machine) with uncommitted
  tracked changes. Standing agents and orchestrators are never stopped this way.
- **Stopped is not lost.** The session keeps its history (`sdkSessionId`); `message_agent` resumes it. Its transcript says
  why it was stopped.

## Loops, limits and safety

- The dispatcher reaches people only through ledger decisions, one reply per decision.
- A person's orchestrator files or updates at most 3 times, and follows up with one worker at most 3 times, between two
  messages of its person. Harness messages alone cannot keep it going.
- A person's orchestrator messages another person at most 3 times until that person writes to their own orchestrator.
- People are not capped per hour or per day (Ben, 2026-09-29): only the per-message budget above holds. Automated
  sources (standing agents, the Discord/FFBox intake, once they file here) get at most 10 requests an hour and 40 a
  day per requester, set per source in config `workLimits.standing` / `workLimits.intake` (`server/work.ts`
  `limitsFor`); repeats are free.
- Attribution on the dispatcher comes from the request (`work_id`). Without one, `for_user` must name someone its
  conversation shows asking, or the system payer; with neither, the tool refuses. "Whoever wrote last" is never used,
  because most of what the dispatcher hears is the harness.
- The dispatcher's destructive and admin tools (`delete_sandbox`, `set_app_config`, `request_app_update`,
  `republish_public`, `add_machine`, `remove_machine`, `create_standing_agent`, `update_standing_agent`,
  `delete_standing_agent`, `approve_delegation`; `server/belts.ts`) run only for a request its person filed or last
  changed in a turn of their own (`humanAsked`). A turn counts as
  a person's only when every message it answers is theirs: the CLI folds messages sent during a turn into it. Request
  text is written by a model that may be relaying injected text, so its "the user asked" is not enough. Recovery tools
  (`host_recovery`, `machine_daemon`) stay free.
- Only its person writes to a personal orchestrator (HTTP 403 otherwise). Nobody writes to the dispatcher, the owner
  included (Ben, 2026-10-03: people talk to their own orchestrator, which files work with it): `POST
  /api/sessions/<dispatcher id>/message` answers 403 "nobody chats with the dispatcher…" for every login and key
  (`DispatcherChatRefused`, checked in the route and again in `Agents.sendWithAttachments`, so no other caller can
  send it a human-authored message either). The harness still reaches it, because those messages are `system` ones:
  `[work request]`, `[work update]`, `[ledger]`, `[machines]`, intake and FFBox notices, `[wake_me]`, `[timer …]`. Interrupts,
  permission answers and the permission mode of the dispatcher stay owner-only; the Intake tab's approve and decline and
  delegation approvals are their own routes.

## What people see

- The home page is your own chat, as before.
- The sidebar lists, under it, the other people's orchestrators (read only) and the Dispatcher, with its open requests
  ("1 question · 2 active").
- The Dispatcher page has two tabs. Requests lists everyone's open requests, questions first, with the stalled and the closed ones behind
  links; a row opens to its brief, workers, pull requests, overlaps and log. Conversation is the dispatcher's log, read only. Where the
  composer would be, a line says nobody writes to the dispatcher and links "Talk to your orchestrator" (your own chat).
- Decisions arrive in your chat as one-line notices ("Merged into w15: “Belts drop items…”") that open the request.
- A message from another person arrives in your chat as an amber notice, open, with their name and text ("Lothsahn:
  Could you run the firewall script on BEAST?"); Open goes to their chat. Until you open your chat, the sidebar's
  Orchestrator row has an amber count ("Unread: 1 message from Lothsahn"), and your devices get a "Message from
  Lothsahn" notification.
- Your heartbeat is your own, and so are your orchestrator's timers: the clock button in your chat's header lists them,
  with pause, resume and cancel. Owners see the dispatcher's on its page.

## The first start

The shared chat becomes the dispatcher and keeps its conversation, so it starts out knowing what is in flight. Every
login gets its own orchestrator with one line saying where the old conversation went. The old global heartbeat becomes
the owner's. Pending `wake_me` wakes, standing agents and delegation requests carry on unchanged. Everything the harness
already sent to the shared chat still reaches the dispatcher, which is why the shared chat became the dispatcher rather
than Ben's own.

## Not in this version

- Delegation requests are not ledger items until their worker starts (then it is recorded), so a dashboard or
  automatic approval skips the overlap check.
- `/mcp` has `list_work` but not `request_work`.
- Roles are still not enforced: a member's work can go to the owner's machines if the dispatcher sends it there (its brief
  tells it not to).
- An idle personal orchestrator keeps its process until the server restarts.
- The dispatcher cannot `message_person`: it still reaches people only through ledger decisions.
- This host's sandboxes still run in the portal's own process. Moving them behind a daemon, as on the machines, is
  [backlog.md](backlog.md) item 1; the dispatcher already addresses a daemon's sandbox as `"<machine>/<name>"`, and
  nothing in the ledger or the routing depends on where a worker runs.
