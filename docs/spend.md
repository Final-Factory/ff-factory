# What a request costs: dollars, tokens, transcripts (w859)

Lothsahn, w859: "I would like you to track the per workitem spend as well as the transcript so we can optimize token usage."
And: "We should keep worker transcripts and numbers for at least 7 days. But make sure we don't run the portal out of disk."

**TL;DR:** (w1160: a request's headline cost is its **workers' own** cost; the dispatcher's, orchestrators' and ops worker's turns on it are its **coordination**, billed beside it, see "Coordination".) Every turn of every agent is now priced from Claude Code's own per-turn usage (the SDK result's `modelUsage`: input,
output, cache read and cache write tokens and dollars, per model) and added to the request the agent was on when the turn began.
`data/spend.json` keeps, per request (`wNNN`), its dollars and tokens per model and per session, and where the context tokens went.
It outlives both the ledger (which drops a request a week after it closes) and the transcripts. A request's transcripts are kept
**7 days after the request closes** (while it is open: for as long as it is open), and a disk guard compresses and, only past
that, deletes transcripts as the disk fills. Everything labelled *estimated* below is one of: a turn that ran before this
existed (tokens estimated from its dollars), a daemon too old to send usage (dollars only), or the split of a session's context
among kinds of content (always an estimate; the totals it splits are not).

## Where to read it

| | |
|---|---|
| `list_work` | each request's line ends `Cost so far: $12.34 (3 session(s); in …, out …, read …, write …)`; `list_work` with an `id` adds the full spend (below) |
| `read_work` (workers) | the same cost line on their own requests |
| `spend_export` (workers, with a grant) | the record as CSV for any time range, by request, session, model, effort and role (w2653; "The export" below) |
| `spend_report` (orchestrators) | no argument: the last 7 days' top requests (by the workers' own cost, coordination beside it: see "Coordination") with where their tokens went, cost by kind of work, where the money goes inside sessions, the transcripts' footprint. `days`, `top`; `request: "w859"` one request in full (models, every session with tokens, cost and a link to its transcript, how long each transcript is kept); `session: "<id>"` (its top 20 requests by cost and a count of the rest; `requests: N` lists up to 2,000, w1159); `footprint: true` |
| Dashboard | Dispatcher page: a cost on each request's row, a **Spend** block in its opened row (models, sessions with transcript links, categories), and a **Spend** tab: the analysis |
| HTTP | `GET /api/spend/summary`, `/api/spend/request/<id>`, `/api/spend/report?days=7&top=10` |
| Scripts | `scripts/transcript-footprint.ts <data dir>` (the three transcript measurements, exact, read-only, run on the portal host); `scripts/spend-claude.ts` (the same analysis over a machine's own `~/.claude/projects` transcripts: sessions that ran before this existed, and any machine's, without the portal) |

A **request page** (the opened row) lists every session that worked on the request with its tokens and cost, its role
(worker, dispatcher, personal orchestrator, ops worker, standing agent) and a link to its transcript (`#/session/<id>`), and says
when each transcript may be deleted.

## The per-session record of model and effort (w2653)

Each session in `data/spend.json` carries `runs`: what it ran on, one entry per change, `{at, model, effort, src, from}`, and its
`sandbox`. `AgentSession` (server/sessions.ts) puts `usage.run {model, effort}` on every result line: the model it passed the SDK
(`start`, and a coordinator's per-turn `switchModel`, w1158) and the effort it passed (`Options.effort`); absent effort means none
was passed and the CLI ran on its own default. `SpendStore.runOf` labels a turn's run:

| | `src` | `from` |
|---|---|---|
| `usage.run` with an effort, or the session's own `effort` (a daemon from w2653 on) | recorded | `process` |
| no `usage.run` (an older daemon), the session's `model` and an `effort` it was started with | recorded | `session` |
| an effort nobody passed: the role's default (the config now, else the table below) | inferred | `default` |

A new entry is added when the model, effort or label changes. Requests carry `filedAt` (the ledger's `createdAt`) beside
`closedAt`.

**The turn log.** Every live turn is also appended to `data/spend-turns/YYYY-MM.jsonl` (UTC month), one line:
`{at, s, role, m, sb, model, effort, src, req: [[id, weight]], models, est}`. It is what lets the export cut any time range
exactly; `spend.json` keeps whole-life totals and UTC days only. It starts at w2653's deploy (2026-10-31); `correctHistory` and
the transcript backfill do not write it. No account is in it.

**Backfill** (`SpendStore.backfillRuns`, at start and every 5 minutes for sessions the transcript backfill added since): a
session with no `runs` gets one, at its first turn. Model: the session's own while it is still in the state (set from the SDK's
init), recorded; else the model that billed most in it, inferred. Effort: the session's own `effort` if one was asked for,
recorded; else the role's default when it started, inferred (`inferredEffort`, server/spend.ts):

| Role | Default effort | Source |
|---|---|---|
| worker, standing agent | `high` before 2026-10-24 07:20 UTC, `medium` from then | `cfg.worker.effort` (agents.ts `machineSandboxSpec`, standing.ts); set to medium after w2000 (PR #629) made it settable (r15's boundary); w2010 (PR #642) made medium the code default |
| personal orchestrator, dispatcher | `medium` | `cfg.orchestrator.effort` (`orchestratorOptions`) since the first release |
| ops worker | `medium` | `OPS_LIMITS.effort` (server/opsWorker.ts) since w597 |

`from` says which part was guessed: `backfill: model recorded, effort default` is inferred, because one value was a default.

## The export (w2653)

`spend_export` is a worker tool (group `ledger`, server/spendExport.ts), read-only and granted per request the way ledger
reading is: the person's orchestrator sets `spend_read` on its own request (`request_work spend_read: true`, or
`update_work {id, spend_read: true}`; never on an intake request; docs/orchestrators.md, "Workers read the ledger"). A worker
who needs it says so in its report; its orchestrator grants it. The answer is CSV with `#` header lines, paged at 40,000
characters (`offset`, `limit` up to 2,000 rows). `since` and `until` take any ISO time with a zone, or a UTC date (default: the
last 7 days); `role` filters sessions and turns.

| `view` | Rows | Columns |
|---|---|---|
| `summary` (default) | requests closed **done** in the range, all and by kind; sessions **started** in the range by role × model × effort they started on | count, sum, mean and median of the workers' own dollars and the coordinators'; count, recorded/inferred, output tokens and dollars (sum, mean, median) |
| `requests` | requests closed in the range, or open and active in it | id, title, kind, status, person, filed/first/last/closed times, `worker_usd`, `coord_usd`, `total_usd` (whole life, split exactly by `splitOf`), the workers' tokens, turns, worker sessions, their model/effort runs |
| `sessions` | sessions active in the range | role, machine, sandbox, person, first/last, model, effort, `src`, changes, every run, turns, in, out, cache read, cache write, dollars, the requests it served with dollars |
| `turns` | the turn log cut exactly to the range; `group_by` request (by weight), session, model, effort, role, day, or `none` (one row per turn) | turns, sessions, tokens, dollars |

Cost per finished request: `summary` (or `requests` filtered on status done). Output tokens per session by model and effort:
`summary`'s sessions rows, or `sessions`. Nothing is subtracted by the reader: the workers' and coordinators' dollars are
separate columns. The export names no account (not even its label), token or key: the person column is the session's or
request's person's display name.

## What is recorded, and where it comes from

`AgentSession` (server/sessions.ts `turnUsage`) puts on each `result` line of a transcript: `usage.cum`, the SDK's cumulative
per-model totals at the turn's end (`result.modelUsage`: tokens and `costUSD`), `usage.main` (`result.usage`, the main loop's own
tokens for the turn) and `usage.meter` (the context reading, below). The same code runs on the machines' agent hosts, so a
machine's result lines carry it too. `Store` (server/store.ts) tells `SpendStore` (server/spend.ts) of every event appended, for
sessions here and on machines alike (`appendFull` and `append`).

The turn's spend is the **difference** between `cum` and the last `cum` seen for that session (`SpendStore.delta`):
- a session's first result, when its transcript holds no earlier result: `cum` is the turn (exact);
- the SDK says a resumed session continues from its saved totals, so the first result after a resume already holds the earlier
  turns: the difference against the stored totals is still the turn;
  totals that grew on every count since the last result are always this case, even when the result says `restarted` (w1161);
- `restarted` (server/sessions.ts `firstResultBase`): a process's first total below the CLI's own total at the session's last
  result (`SessionInfo.sdkCostUsd`), so the CLI began again from zero. Before w1161 the portal compared with its own figure
  (`costUsd`), which runs ahead of the CLI's total once a process starts from zero; from then on every resume was flagged, and
  each portal restart counted the CLI's whole running total again: the dispatcher's and orchestrators' first turn after a restart
  read $165 to $215 (portal journal, auto-compact lines, 2026-10-11..12), 59 dispatcher turns billed to w605 at $1,836;
- totals that start again (a `/clear`; half of the old figure or less): counted in full;
- a session that ran before this existed, at its first result after the deploy: its totals hold all its history, so this turn is
  `usage.main` priced at list prices, marked estimated; from the next turn on it is exact;
- a daemon that does not send `usage` yet: dollars from the difference of `total_cost_usd` (`costUsd` on the result line), no tokens, marked estimated;
- a compaction (`/compact`, automatic or by hand) writes no result line of its own; its cost is in `cum`, so the next turn carries it.

Dollars are the SDK's `costUSD` (which, on the recent sessions checked, equals the calls' list prices to within 0–3%, below).

## Which account a turn ran on (w1031)

Every turn is also added to the Claude account its process ran on: `SessionInfo.ranAs`, set when a process starts (a worker's launch
spec names it: "vault token vault-lothsahn-1 …EAAA (lothsahn's pool, docs/vault.md)"; before w1078 also "host token …9AAA"; only the last four
characters of a token ever appear). `spend.json` keeps it per request and per session (`accounts`), `spend_report` prints "By Claude
account the turns ran on" and, for one request, "Per Claude account", so a request taken over by another person (docs/vault.md
section 10) shows the turns before the switch on one account and after it on the other. A host session (an orchestrator, the
dispatcher) shows its account key; a turn from before w1031, or a backfilled one, is "not recorded (before w1031)".

## Which request a turn belongs to

`attribute` (server/spend.ts), at the moment a turn's result arrives, from the messages that began it and the ledger as it stood:

| Session | The turn goes to |
|---|---|
| worker | the request in an `[about wNNN …]` line of a message that began the turn (a follow-up from an orchestrator names its request); else the request it was last sent: the ledger's `links` as they stood when the turn began (`servedAt`: the latest `sent` and the `linked` since, as `servedBy` in shared/workState.ts does, but at the turn's start, so a message that arrived mid-turn does not move it); else the `wNNN:` prefix of its title; else `_unattributed` |
| dispatcher, a person's orchestrator | the requests (in the ledger) named in the first lines of the messages that began the turn (`[work request] w859 …`, `[worker update] …`, `[dispatch] …`), split evenly, at most 4, as that request's **coordination** (below); none: its own bucket (`_dispatcher`, `_personal:<user>`) |
| ops worker | the requests its job messages name; else `_ops` |
| standing agent | `_standing:<id>`; the workers its delegations start are ordinary requests (the delegation's work item) |

A turn on several requests (linked requests share a worker) is split evenly between them; the share is recorded (`shared`) and
shown. Overhead that no request owns is listed apart (`spend_report` "Not any request's"). A request's `tied by` line on its page says how
each session's turns were tied: `about`, `link`, `message`, `bucket`, `backfill`.

### The rules as they stand (w1209 audit)

- **Money is conserved.** A turn's dollars are the SDK's difference of cumulative totals; `attribute` returns weights that sum to 1, so every
  dollar of a session is in exactly one share of requests and buckets (`_dispatcher`, `_personal:<user>`, `_ops`, `_standing:<id>`,
  `_unattributed`). Tested: workers' own + coordination + not-any-request's = the window's total, and requests + buckets = sessions, for a mix
  of every kind of session (spend.test.ts "whatever the mix of turns").
- **A coordinator is never billed through the worker rules.** The session's role (`dispatcher`, `personal`, `ops`, `standing`) comes from the
  session when it is live and from the record when the store no longer holds it (`infoOfRecord`); before, a turn of such a session fell through
  to the worker rules (`_unattributed`) and its role would have been rewritten.
- **A worker's linked requests that closed before the turn began are left out** while another is open (`openFirst`): the ledger never unlinks a
  request, so a worker that finished w1 and went on with w2 used to put half of every later turn on w1. A reopened request is open again; all
  closed: they share it, the money has to go somewhere. An `[about]` line is always taken as written.
- **Ids inside parentheses in a harness notice are citations** (`[machines]`, `[app restarted]`, `[restart]`, `[host]`, `[heartbeat]`,
  `[data restored]`, `[machine updates]`), not the turn's subject. The coordinators' rule text is the system prompt, never a message, so it is not read at all.
- **Where the tokens go: `carried`.** The context meter starts empty with each process. A conversation resumed after a restart reads a
  context it never saw built, and that read used to count as `base`. The first call of a resumed process now puts that unexplained cache read in
  `carried` (and later calls keep reading it as carried). Dollars and attribution are unaffected either way: it moves a share of a request's
  dollars between two categories. Since w1484 a resumed process picks up the meter's tally instead (below, "A conversation across
  processes"), and `carried` is only what came before it.

### A conversation across processes (w1484)

Lothsahn: "Can we eliminate carried by accounting for it properly as each worker goes?" On 2026-10-16..18 `carried` was 13% of the
workers' spend ($304) and 36% of w1386's. A worker's conversation runs in many processes: its agent host closes when the process
ends (a far check-in, a usage hold, a daemon update, a stop) and the next message starts a new one that resumes it
(machine/agentHost.ts), and the portal's own sessions start again after a restart. The meter lived in the process.

Now `AgentSession` saves the meter's tally (`ContextMeter.snapshot()`, a `MeterState`: characters held by category, what is new since
the last call, the last call's context, the base and the files read, hashed) after every model call, every turn and the process's
end, one JSON file per Claude Code session id (server/meterStates.ts): `<appDir>/meters/` beside a machine's agent hosts, `<data>/meters/`
for the portal's own sessions, removed 14 days after their last write. A process that resumes the conversation calls
`ContextMeter.resume(state)`: the history stays in its categories and only the base is measured again, by its first call:

- **by the cache** when that call's cache read covers the base the process before measured: a cache read is an exact prefix match, so
  the prompt begins with the same tokens and the base is the same;
- **by counting** otherwise (a cold cache, a system prompt that changed: its git status, CLAUDE.md): its context less the history the
  last call read (its context less its base, real tokens) and what is new since (characters);
- **`history-shrank`** when the count comes out below the base before: the history lost tokens the stream never shows, and the base
  stays. Replayed on beast's 3 days (cut wherever a turn began after 30 minutes idle, 63 resumes in 24 transcripts): 6 of the 38 cold
  resumes counted 11k to 57k tokens less, and each followed Claude Code's `thinking_drop` (old thinking dropped after a long idle); 13
  counted 13.5k to 16k more, each after its `instructions` (CLAUDE.md sent again), which is base content.

The turn's `MeterTurn.resumed` says which (`{ kept, base, prevBase, by }`, or `{ kept: false }`). With no saved state (a conversation
that began before the deploy, one moved to another machine, a file older than 14 days) the history is `carried`, as before.

Replayed the same way on beast's worker transcripts of 2026-10-16..18 (47 transcripts, the CLI's jsonl through the meter,
`scripts/meter-resume-replay.ts`): cut at every turn (409 resumes), `carried` was 34.7% of the list-price dollars with the old meter
and **0.000%** with the kept tally; cut at 30-minute gaps (63 resumes), 6.2% and **0.000%**. Every category stays within 1 point of
the same transcripts replayed as one process (base 12.0% against 11.2%, unitemised 6.4% against 7.1%: the CLAUDE.md sent again is base
when the base is counted). The cuts fall inside transcripts of real processes, so a cut's first call is what a resume with the same
prompt would send; a real resume's prompt can differ too (its git status), which the counting covers. After the deploy the check is
`carried`'s share, and `resumed.by`, on the first resumed workers' turns.

### What unitemised was (w1556)

lothsahn: "Why is over half the cost on w1510 unitemized?" w1510's worker (29bac897, lothdesktop) read 37% of its $118 as
`unitemised` and 2% as `base`; w1544's (a3b0bf2c, 2 turns) 10% and 14%. Three holes, each closed:

- **A carried conversation lost its base for good.** A process that resumes with no saved tally (one that began before w1484, as
  29bac897 did: its process was restarted onto new code at 2026-10-19 01:31Z, portal journal) sets its base to 0, because the base
  is inside the carried history. A compaction then drops `carried` (the portal asked 29bac897 to compact at 02:28Z with 568k in context,
  and three more times by 11:09Z), and the base stayed 0: every later call read the real base, ~55k tokens, as `unitemised`, and each later
  process "counted" a base of a few thousand tokens against it. And on a cold cache (a resume after an hour's CI wait) the carried
  history is written again, not read: only the read part was `carried`; the rewritten part went to `unitemised` and every later
  call read it there. Now the rewritten history is `carried` too, a carried base waits for the next compaction, whose first call
  holds only the base, the summary and what is new, and measures it (`MeterTurn.resumed.by` is `carried` until then), and a saved
  tally with a base under `MIN_BASE` (8k tokens; a real one is 34k at p10) is measured again the same way. Better still, a process
  that finds no tally rebuilds it from Claude Code's own transcript (`rebuildMeter`), so the history is in its categories and
  there is no `carried` at all.
- **What Claude Code adds out of the stream's view.** The SDK stream never shows the CLI's attachments, and its transcript
  (`~/.claude/projects/<cwd>/<session id>.jsonl`, on the machine the agent runs on) records each before the call that reads it:
  `total_tokens_reminder` on every call, `edited_text_file`, `diagnostics`, `date`, `environment` and the like (`reminder`), hook
  output (`hook_success`, `hook_additional_context`, …: `hook`), the CLAUDE.md, skill and agent lists a resumed process sends again
  (`base`), the task notifications and cross-session messages the CLI writes itself (`brief`), and the files and tasks a
  compaction attaches beside its summary (`compact-carry`). AgentSession tails that file and feeds the meter before each model call
  (server/cliTranscript.ts, `ContextMeter.attachment`). Records the CLI never sends (`prompt_snapshot`, `deferred_tools_record`,
  `thinking_drop`) are skipped; the base a process's first call sends, and the one a compaction sends again, is in the base the
  meter measures.
- **What a compaction carries over** beside its summary (the newest messages it keeps, which no attachment names) is what the call
  after it holds beyond the base, the summary and what is new: `compact-carry`, held and read as such afterwards.

Replayed (measured, `scripts/meter-unitemised.ts` and the step-by-step run behind it, over beast's 121 worker transcripts of
2026-10-17..19, $1,333 at list prices), unitemised as a share of the list-price dollars:

| | tally kept (w1484) | first resume carried (as 29bac897's was) |
|---|---|---|
| before w1556 | 6.61% | 18.77% (carried 7.6%) |
| + a carried history written again is carried, the base measured by a compaction | 6.61% | 6.11% (carried 19.6%) |
| + the base sent again (`base`) | 5.71% | 5.53% |
| + reminders (`reminder`, 2.2% of the money) | 4.25% | 4.14% |
| + hook output (`hook`, 0.3%) | 4.03% | 3.93% |
| + notices the CLI writes (`brief`, +1.4 points) | 2.96% | 2.98% |
| + compaction attachments and carry-over (`compact-carry`, 0.1%) | **2.87%** | **2.98%** |

With the tally rebuilt from the transcript a carried resume reads like a kept one (the left column). What is left, under 3%, is
the error of the characters' estimate (2.3 characters a token is a fit over all content; reminders, JSON and code differ) and
attachments whose rendered text has wrappers their fields do not show (estimated, not measured). A process whose transcript it
cannot read (another layout of the projects folder, a CLI that writes none) goes on as before w1556. Turns recorded before the
deploy keep their categories; a request's breakdown is right from the deploy on.

### Corrections to history (w1209)

Two rules changed in the a9d5eae restart (2026-10-13 01:52:30 -06:00, `RULES_FROM_MS`), and the turns recorded before it by the old ones were wrong:

| | Old rule | Cost, measured | Now |
|---|---|---|---|
| A restart's first result | the CLI resumes from its saved running total, so the portal read the whole total as one turn (`delta`, w1161) | the portal's own auto-compact lines on 2026-10-12 give 7 such turns of $197.89 to $215.30 for the dispatcher and the two orchestrators, **$1,456.89** in one day; the same applies to every resumed worker (not measured) | the difference against the last totals |
| An id cited in parentheses in a harness notice | billed the turn to that request (`namedIdsIn`, w1160) | w605: $1,836 (60 dispatcher turns) | the turn is the coordinator's own |

`SpendStore.correctHistory` records those turns again by the current rules, once per session, 150 seconds after the portal starts, in the
background (`repairSpend` in server/index.ts, which first keeps a copy of the record as `spend.json.pre-w1209`): the transcript is replayed twice, by
the old rules and by the current ones, and for each live-recorded turn the two read differently the old reading is taken out and the current one put
in, in the session and in every request it touched. It changes the record by the difference and nothing else (the context categories come from the calls' own
usage and do not move). The turns the backfill estimated from the portal's cost totals (before the live recording started) carry the same double count in another form: the portal's own
total doubled at a restart, so the turn after it reads as the whole running total again. A backfilled turn that costs at least 90% of what the session had cost so far, from $20
up, is that restart and nothing else (a real turn cannot cost as much as the whole session so far), and what it really cost is what is left over; its tokens are estimated again from that.
It refuses a session whose replay does not explain its recorded total within 5% and says so in the journal
(`spend repair: … left as recorded`); a session whose transcript is gone, and every turn backfilled before the live recording started, stay as recorded. A coordinator's
coordination days are rebuilt from the corrected record.

### A resume that carried older totals (w2007)

lothsahn, w2007: "find out why a few requests cost far more in coordination ... than in their workers' own work". The four outliers of the 30 days to
2026-10-24 were one artefact, not spend:

| Request | Billed (spend_report) | What the numbers show |
|---|---|---|
| w1737 | Ben's orchestrator $425, 4 turns on 2026-10-22: 925M cache read, 4.2M output | measured: a coordinator's turn makes 1.7 model calls on average and at most about 30, at a context that peaks near 112k (portal_logs coordinator_context, 24 compaction cycles of the three coordinators, 2026-10-24: 637 turns, about 1,080 calls); 925M cache read is about 10,000 calls at that size, in a request that lived 1 h 43 min |
| w1349, w1350, w1351 | the dispatcher $96.3 to $96.6 each, the same 8 turns on 2026-10-15 split three ways (about $290) | the same shape: 215M cache read a request |
| w863, w788 | the dispatcher $67 each, backfilled, 2026-10-10 | 335M cache read beside 3k to 10k output tokens: no real calls read that much and write that little |

The cause (traced in the code): when the CLI resumes a conversation it continues from the totals its transcript saved, and those can be older than
the last result the portal saw (why its save lags is not known; a guess: a process the portal's restart kills saves nothing after its last save). The first result of the new process is then a little below the
last totals: `firstResultBase` (server/sessions.ts) read "below" as "began again from zero" and flagged it `restarted`, and `delta` (server/spend.ts)
counted every count of it as the turn, the session's whole running total. The backfill had the same rule on its dollar totals (a drop counted as the
new total in full), and `estimateTurn` then turned those dollars into cache reads, which is why w863 and w788 read hundreds of millions of cache
tokens beside almost no output. The turn went to the request its starting message named, so whichever request was named at a restart took the whole
running total.

Now (`carriedTotals`, shared/spend.ts): totals below the last ones, no lower than half, whose read tokens are more than four times the turn's own
main-loop usage plus 2M, are the older save: the turn is billed its main loop's usage at list price (an estimate, labelled), and the session's
figure stays where it was. A count that really began again still holds about one turn and is counted in full. In the backfill a drop to no less than
half reads nothing (`backfillTurnUsd`). `SpendStore.correctCarried` takes the carried totals back out of the turns already recorded, once per session
(`carriedV`), on the same request and day so coordination moves with it, and only for turns before the first one the new rule recorded
(`carriedFrom`), so the resumes at the deploy are not taken out twice. It reads only the messages and results of the transcript, in pieces
(`Store.scanTranscript`): `readTranscript` reads a file into one string, and Ben's orchestrator's transcript (1,306.6 MB on 2026-10-24) is past the
longest string Node makes, so correctHistory and rebuildCoordination cannot read it (they log a warning and leave it as recorded). The journal line is
`spend repair (w2007): N session(s) looked at, $X of carried running totals taken out of M turn(s)`.

**What a coordinator's turn costs is still the whole turn.** A turn's dollars go evenly to the requests (at most 4) named in the first lines of the
messages that began it, however long it ran (`attribute`). That is exact for the usual turn of a few calls; a coordinator turn that ran away would
bill all of it to whichever request started it. A per-turn budget stops such a turn (w2007; docs/orchestrators.md, "A per-turn budget").

### Audit findings (w1209, 2026-10-13; measured = from the portal's `spend_report` on 3c98743 or its journal, estimated = said so)

| # | Finding | $ | Where | Fixed |
|---|---|---|---|---|
| 1 | The restart notices cited "(w605)" and billed the dispatcher's restart turns to it | measured: w605 coordination $1,836 over 7 days, $1,475 of it 10-11 and 10-12; after the repair $0.49 (its real mentions) | machines.ts:802 and agents.ts:1168 texts, `namedIdsIn` | going forward in a9d5eae (#362); history by `correctHistory` |
| 2 | After the first fix w605 read as $1,475 of *worker* cost in a 3-day window | measured | the first split's replay (spend.ts `rebuildCoordination`) | #381 |
| 3 | A restart counted the CLI's whole running total as one turn | measured, before and after the repair (spend_report, 2026-10-13 14:10Z and 15:35Z): 3 days total $14,908 → $5,563, coordination on requests $8,117 → $226, not any request's $1,630 → $413, workers on requests $5,161 → $4,924 (-$237: resumed workers too; w1063 $270 → $153); 7 days total $23,034 → $12,073, coordination $9,674 → $701. The portal's own lines: $1,456.89 on 10-12 for three coordinators | `delta` (w1161) | going forward in a9d5eae; history by `correctHistory` |
| 4 | A worker kept its closed requests linked and put a share of every later turn on them | not measured (needs the ledger's links over time) | `servedAt` | `openFirst` |
| 5 | A coordinator whose session the store no longer holds was billed through the worker rules | not measured; no case seen | `record` → `attribute(info undefined)` | `infoOfRecord` |
| 6 | A resumed conversation's context counted as `base` | category only, no dollars: base is 71% of in-session spend in the last 3 days (measured), the part that is resumed context is not separable from the record | `ContextMeter.call` | `carried` going forward |
| 7 | A bucket's request view labelled its days "workers" under a "coordination" header; `_unattributed` answered 87,000 characters | presentation | `renderRequest` | one figure per day; 25 sessions then a count |
| 8 | A turn that names several requests is split evenly over the first 4 | no loss or double count (weights sum to 1, tested); a batch of messages naming different requests puts the whole turn on the first four: not measured | `attribute`, `namedIdsIn` | not changed. After the repair coordination is $701 of $12,073 in 7 days (5.8%) and not-any-request's $679, so a per-message weighting could move a part of $701 between requests: not worth a second method (a guess at the size, from those two figures) |
| 9 | The repair's first release took each turn out of, and put it back on, the session's biggest account, so other accounts read negative | measured: token:5d6d575eda30 -$2,018 and token:0d94ad2b5488 -$1,428 in the 7-day report (-$565 and -$757 in 3 days) | `correctHistory` `add(account)` | spread by the session's own mix; the accounts of the 11 sessions corrected are rebuilt from `spend.json.pre-w1209` (`repairAccounts`, an estimate for the requests) |
| 10 | The backfilled (estimated) part has the same restart double count, by the portal's doubled own total | measured: the repair on d00bfa8 took **$72.52** out of 3 backfilled sessions (the signature: a turn that cost at least 90% of the session so far, from $20 up), against $10,980.08 in the live part. The largest 7-day coordination, w863 $68.10 (dispatcher $67.35, 9 turns) and w788 $66.87 (dispatcher $66.75, 5 turns), both on 10-10 and all estimated, were NOT restart double counts: $7.5 and $13 a turn is not the running total (about $100 or more on 10-10). Most likely real, heavy dispatcher turns (a release's CI polling); not provable, because a backfilled turn has no per-call usage ("a context reading of 1 model call") | `backfillSession` `d` | `correctHistory` (fixV 2) |
2,073 | `backfillSession` `d` | `correctHistory` (fixV 2) |

**Checking the restart repair against the transcripts** (measured by the orchestrator in /srv/fff/data/transcripts, 2026-10-13; the conclusion is mine):
the dispatcher's transcript (f8862ae9) has `"restarted":true` on 22 result lines; at the two restart lines with a value on each side the
CLI's total CONTINUED (line 31875 → 31880: 198.0636 → 198.1108, the turn cost $0.05; line 31968 → 31974: 199.4973 → 199.5540), and its
`cum.<model>.usd` equals `costUsd` in every line sampled (last 243.73). The old rule counted ~$198 for each of those restart turns. 22 such lines at a
running total of about $100–245 is about $3.6k–4.3k; the repair took $3,648 off this session ($5,167 → $1,519). Its live-recorded part now
is about $275 against a final running total of $243.73 (lothsahn's orchestrator $134 against $253.17, Ben's $269 against $226.93, estimated: the rest of
each session's total is backfilled from the older `costUsd` lines and cannot be checked this way). Drops of `costUsd` exist but early (a fresh process
or a /clear, e.g. line 227 → 246) and without the flag; both rules count those in full. Only 2 of the 22 restart lines were sampled with a value on each
side: the full list of drops is not pulled.

Not any request's, after the repair: $413 in 3 days (Ben's orchestrator $185, the dispatcher $172, lothsahn's $42.23, the sentry $7.44, ops $6.11) and $679 in 7 (measured).
They are conversations and heartbeats that name no request, not misbilled worker spend. In the 7-day window $5,513 of $12,073 is under "not recorded" as an account
(turns from before w1031 and backfilled ones: estimated, $6,203 of the window).

## Coordination: billed apart from the workers' own cost (w1160)

Lothsahn, w1160: "We should still track per request, but bill it separately." The dispatcher's, a person's orchestrator's and the
ops worker's turns (the **coordinators**) are still counted for the requests their messages name, but as that request's
**coordination**, beside its **workers' own cost**, never inside it. Before, w605 read $1,836 and w979 $308 over 2026-10-10..12, nearly all
of it dispatcher and orchestrator turns that happened to name them (the orchestrator's reading of that window's top 20: about $5.8k of $6.9k
was coordinator spend; an estimate, not a measurement).

| Where | Shows |
|---|---|
| `spend_report` (default) | one line: *the workers' own cost on requests $A; coordination on requests $B (dispatcher $, Lothsahn's orchestrator $, ops worker $); not any request's $C* (A + B + C = the window's total, with no turn counted twice). **Top requests are ranked by the workers' own cost**; each row reads `workers $X, coordination $Y (by coordinator)`. A short list "Most coordination on a request" ranks by coordination, so a request with no worker cost still shows. Kinds of work are the workers' own cost, with coordination beside it. "Where it went" (the category split) and "by model" and "by account" stay over every session, coordinators included |
| `spend_report request:` | workers' own cost, coordination (per coordinator), all together; the days (workers / coordination); sessions with workers first, each coordinator marked *coordination* |
| `spend_report session:` | a coordinator session says its cost is coordination and lists the requests it billed it to, apart from *Not any request's* (its `_dispatcher`, `_personal:<user>`, `_ops` bucket); a worker's list is its workers' own cost |
| `list_work id`, `read_work` | `Cost so far` is the workers' own; a second sentence gives the coordination |
| Dashboard | a request's chip reads `$workers + $coordination coord.`; the opened row and the Spend tab show both |
| HTTP | `/api/spend/summary` `usd` and the tokens are the workers'; `coordinationUsd` is the coordination; `/api/spend/report` has `workers`, `coordination`, `topCoordination` and, per row, `coordination` |

**The method (an estimate).** A coordinator's turn is split **evenly** among the requests (at most 4) named in the first lines of the
messages that began it, the rule that was already in force (`attribute`, `namedIdsIn`). Dollars and tokens of the turn are measured;
how many requests it served is not knowable (the model works on all the messages of a turn together), so the shares are an even split and
are labelled as an estimate in every output. The alternatives (by message length, by the tokens each id's text takes) would be as
unmeasured and would cost more to explain. A turn that names no request is in its bucket, as before; it is in the total, never in a request.
`namedIdsIn` ignores an id inside parentheses in a harness notice (`[machines]`, `[app restarted]`, `[restart]`, `[host]`,
`[heartbeat]`, `[data restored]`, `[machine updates]`): w1161 found that "(w605)" in two notices that reach the dispatcher on every
portal restart billed those turns to w605 (a citation of the update rule, not the subject). That fixes turns from the deploy on; turns
already recorded stay where they were put.

**What is stored.** A request keeps `coordDays`: dollars and tokens of coordinator turns by the coordinator's **session id** and UTC day,
a part of `days`; workers' own cost in a window is `days` minus it. The all-time split needs nothing new: each of the request's
`sessions` already has its role, so `SpendStore.splitOf` is exact for every request, old ones too. Only a window report needs the days.
Turns recorded before days existed get them from the coordinator's own transcript (a chat is never pruned), 150 seconds after the
portal starts, one session at a time (`rebuildCoordination`; a session with `coordV` 2 is done). The replay is **by the rules that recorded
each turn**: before `coordFrom` (the first turn the current code recorded) the old attribution (an id cited in parentheses in a harness
notice counted) and the old cost rule (a restart's whole running total was one turn); after it, the current ones. No day holds more
coordination than the request spent that day, and what the replay does not explain goes to the days with room. Until the rebuild finishes a
window report shows $0 coordination for the old part; the days of the old part are an estimate, the sums are not.

*The first version got this wrong (w1160, 2026-10-13):* it replayed old turns by the new rules and scaled the result up to the recorded size,
so w605's $1,836 of dispatcher turns (billed to it by the restart notices that cite "(w605)") were spread over the days of its few real mentions,
and the 3-day window read $1,475 of **worker** cost (days minus too little coordination) beside $0.13 of coordination. Its days, keyed by
"dispatcher" and the like, are dropped at load and every coordinator is rebuilt.

## Where the tokens go inside a session

Claude Code reports how big each model call's context was (input, cache read, cache write), never what is in it. The
`ContextMeter` (shared/spend.ts) shares each call's real token counts among the kinds of content the context holds, by characters:
cache reads go to what was in the context before the call, cache writes and uncached input to what is new since the previous
call, output tokens to the agent's own text. The agent's own output (thinking included) is carried in the next call's
context exactly (the fit below: 1.01 tokens per output token), so it is counted by tokens, not characters. What no content explains is `base` (on a resumed conversation, `carried`: the context the process never saw built; since w1556 the attachments Claude Code adds out of view come from its transcript: "What unitemised was")
(the system prompt, tool definitions, CLAUDE.md, skill lists, reminders). Categories come from what the week's tool results held
(`toolKind`): `file-read` (Read, `sed -n`, `cat`, `head`), `reread` (a range of a file already read in the session; `afterCompact`
when the summary dropped it), `search`, `git`, `ci-poll` (`gh pr checks`, `gh run`, `sleep`/`until` loops, Monitor, wake_me),
`build-test`, `shell`, `edit`, `mcp-unity`, `mcp-machine`, `web`, `subagent`, `brief` (messages to the agent), `summary` (after a compaction), `assistant`, `base`.

**Calibration (measured, 2026-10-10, beast, last 7 days, 52,187 calls):** a least-squares fit of the tokens a call wrote (cache
write + uncached input) on the characters of tool results and messages since the previous call, and that call's output tokens,
gave 0.431 tokens per character (2.32 characters per token: JSON, paths and escapes tokenize densely), **1.01 tokens per previous
output token** (the carried output, thinking included) and 96 tokens a call of nothing visible (reminders, hook output: they fall in
`base`). `CHARS_PER_TOKEN = 2.3`, `OUTPUT_TOKENS_PER_CHAR = 0.75` (30.8M output tokens for 40.9M visible characters: a third of the output is thinking
no transcript shows). With the 3.5 first guessed, `base` read 54% of the money; with the measured 2.3 and exact output tokens, 25%.
The first call of a session reads a median 54k tokens of base (p10 34k, p90 58k, 206 sessions): skill list ≈ 8k, CLAUDE.md and
instructions ≈ 7.7k, a prompt snapshot ≈ 6.5k, agent and deferred-tool lists ≈ 4.5k, MCP instructions ≈ 1k (characters ÷ 3).

A category's dollars are its share of the request's measured dollars: the split is an estimate, the sum is not.

### The agent's own output read as base until w1469

The meter takes each call's output tokens from the SDK's `assistant` messages. The CLI sends those as each content block ends,
with **message_start's usage** (an output of about 1), and writes the real count into them only after the stream's
`message_delta` (measured in the CLI binary of SDK 0.3.284: `case"message_delta":… for(let tc of pu){tc.message.usage=Da …}`), so
its own transcript has the real count and the stream never did. The agent's output, thinking included, which every later call
reads again, was explained by nothing and fell in `base`. Since w1469 `ContextMeter.output` takes the count from the
`message_delta` stream event (server/sessions.ts, `stream_event`), and `ContextMeter.summary` gives a compaction's summary
(`compact_boundary` `post_tokens`) its own category; it was base too, every call after a compaction.

How big it was (measured, `scripts/spend-claude.ts` over beast's worker transcripts, 2026-10-15..18, 49 sessions, $1,159 at list prices):
with the transcripts' real output counts base is 28% and the agent's output 36%; with every call's output set to 1, as the stream
gave it, base is 60% and output does not appear, which is the portal's reading of the same days (base 59%, spend_report). The
real base context, the first call of a session less its brief, read again by every call, is 56k tokens a call and 12.7% of
those days' money (w1469's findings).

A second hole put more in `base`. Whatever a call's write did not explain went to base, and after a pause of over an hour (the cache's
1-hour lifetime) a call writes the whole history again: all of it was base. Since w1469 the base is **measured**: the first call of a
process gives it (its context less what the meter saw added: the brief). Every later call reads the base first, then what the context
holds; its write is what is new, then the part of the base and the history the cache did not cover. What is left either way is
`unitemised`: reminders and hook output Claude Code adds and the stream never shows (the `<total_tokens>` line on every call,
`edited_text_file`, a CLAUDE.md read again after it changed on disk), and the error of the characters' estimate. A resumed process
measures its base again from the tally the process before kept (w1484, above); without one, its carried context holds it, as before. Replayed on the same 3 days (`spend-claude.ts`): base **12%**
($144, the same as the independent measure above), unitemised 8%, the agent's output 40%, file reads 16%.

Turns recorded before the fix keep their categories: their per-call usage is not in the
portal's transcripts, so they cannot be split again. A window that ends after the deploy is right from the deploy on.

## What fills a worker's history (w1480)

lothsahn, 2026-10-18: "How can we make it so the converaation history is more terse? Should we look at using caveman from Julius
Brusse?", then "File it: measure the history, then pilot caveman and quieter tool output". Measured on beast's own transcripts
(`~/.claude/projects/*/*.jsonl`, main loop, 52 sessions and 13,735 calls, 2026-10-15..18): a call read **363k** tokens on average,
the history grew **1,413** tokens a call (median 906), and output was **35% thinking** (all three measured: usage). What later calls
re-read, by content (each piece's tokens times the calls after it until a compaction; the totals are exact, the split by characters
an estimate, tool results at 2.18 characters a token fitted to the measured growth):

| What | Share of re-reads | Inside it |
|---|---|---|
| Tool results | **46%** | shell file reads (`sed -n`, `cat`) 14%; searches 7%; other shell 6%; MCP 5% (`get_test_job` 1.4%, `read_work` 1.3%); Read 5% (images 2.6%); git 2.5%; gh and CI polling 1.1%; builds and tests under 1% |
| The agent's own output | **33%** | thinking 13%; tool-call input 18% (Bash commands and scripts 10.5%, Write bodies 4.4%, Unity `execute_code` 1.3%, Edit 0.8%); **text between tool calls 0.8%; end-of-turn reports 0.5%** |
| The first call's content (CLAUDE.md, skill and agent lists) | 10% | |
| Reminders Claude Code adds later | 8% | the `<total_tokens>` line on every call, LSP `diagnostics`, CLAUDE.md files of other folders, `edited_text_file` |
| Messages to the agent | 2% | |

Thinking stays in the context: in 688 pairs of calls where only a tool result under 600 characters came between, the context grew
by at least 90% of the first call's whole output, thinking included, every time (measured). Of the output tokens, thinking is 35%,
tool-call input about 59%, text between tool calls 2.8% and reports 3.5% (thinking measured, the rest split by characters).

So prose is not where the history is. Caveman-style terse prose can only cut its 0.8%; the history is tool output and tool input.

**Caveman** (github.com/JuliusBrussee/caveman, read at bad48a0 of 2026-10-17, Apache-2.0 since 3.0.0): a skill plus a plugin whose
SessionStart and UserPromptSubmit hooks inject its rules again. Its own `docs/HONEST-NUMBERS.md`: output -3% at the median against a
plain "Answer concisely." control (n=10, claude-opus-5-5); "Skill itself does not compress input, context, files, or model thinking
tokens"; outside A/Bs -8.5% of output (JetBrains, 86 tasks) and -8% on top of a CLAUDE.md that already asks for terse replies. We do
not vendor it: its rule file is about 4.7k characters, read again on every call, for a cut a few lines of our own make.

### Terse prose between tool calls, a pilot

`server/terseProse.ts` appends a short rule (`TERSE_PROSE_RULE`, under 600 characters) to the system prompt of a share of worker
sessions: nothing between routine tool calls, one short line when something must be said, ids and errors exact; reports, PR
descriptions, commits, DONE and still-open lines and anything a person reads stay plain English. Its heading, `## Between tool calls
(pilot)`, marks a pilot session in a transcript (the `prompt_snapshot` record). The share is `worker.terseProsePilotPercent`
(default 50, set_app_config; 0 off), by a hash of the session id drawn apart from the compaction pilot's, so the two can be read apart.
It reaches a session when its process next starts. To check it: pilot against control on sessions started after the deploy, tokens
per call, history growth per call, output and thinking tokens, and whether the requests finished and how their reports read:
`python scripts/history-compare.py --since <deploy time> --reports 10` on each worker machine. Before the pilot (beast, 62 worker
sessions of 2026-10-15..18, measured): 322k context a call, growth 1,510 tokens a call, output 587 a call (thinking 209), text between
tool calls 30 characters a call (22% of calls write any), reports 1,877 characters.

## Workers compact (w1469)

lothsahn, 2026-10-18: "Build 1, 2 and 4: compact at ~200k, compact before long waits, trim the base". A worker's calls averaged
**357k tokens** of context on beast (2026-10-15..18, measured), and every call reads all of it again, so the length of a worker's
conversation, not its base, is most of the money. server/autoCompact.ts compacts workers between turns, with Claude Code's own
/compact and a focus that keeps the requests, the people's words, the branch, the PRs and what is verified and left (`WORKER_FOCUS`):

| Trigger | When | Config (set_app_config) |
|---|---|---|
| `tokens` | the context passed 200,000 tokens (not again before it grew by half that past what the last compaction left, nor within 3 turns) | `worker.compactAtTokens` (0 off) |
| `wait` | the turn ended in a long wait (a person, another request, a merge or a deploy, a check-in 55 minutes or more away; never CI, which comes back within the cache's hour as a rule) with the context at 100,000 tokens or more: compacted while its cache is warm, so after the wait the conversation is written again small, not whole | `worker.compactBeforeWaitTokens` (0 off) |
| pilot | only this share of worker sessions, by a hash of the session id (the same session always answers the same): 34% at first | `worker.compactPilotPercent` (100 all) |

A machine's worker is compacted through its daemon: `compact` (server/machineProtocol.ts), offered in the daemon's hello, carried to
its agent host (machine/agentHost.ts) and run as `AgentSession.compact`; a daemon that does not offer it is left alone. The compaction's
turn end comes back marked (`signal` `meta`), so the ledger reads no report from it (agents.ts) and the last report stays. A worker is
never compacted on a message: `/compact` stays the orchestrators' chat command.

What it should save, modelled call by call over beast's 3 days (w1469; `$TMPDIR` script levers.py: each call keeps its real
output and growth, a compaction costs its read and a 12.5k summary, and the next call writes the compacted context again): the
compaction at 200k **-44%** of the workers' spend (-37% if what is read again after a compaction is three times the 15k guessed);
the one before waits alone -22%; both -46%. To check on the pilot: its sessions' cost per call against the rest's, and what they
re-read after a compaction (`spend_report`, the `summary` and `reread` categories).

### Compacting earlier, a pilot (w2002)

lothsahn, 2026-10-24: "File the compaction pilot plus the base-context trim and noise fixes". Over 14 days 96% of workers'
cache-read tokens came from calls above 100k of context and 78% from calls above 200k (measured by the ops worker), so a share of
worker sessions compacts earlier (server/autoCompact.ts `EARLY_COMPACT_DEFAULTS`):

| Arm | Between turns (the portal's /compact) | Within a turn (Claude Code's own autocompact) |
|---|---|---|
| pilot, `worker.earlyCompactPilotPercent` (default 100 since the result below; it was 50) of sessions, by a hash of the id apart from the other pilots | from `worker.earlyCompactAtTokens` (120,000) | from `worker.earlyCompactMidTurnTokens` (150,000) |
| control, the rest (none at the default 100) | from `worker.compactAtTokens` (200,000) | near the model's window (Opus 5.5: 980,000 less 13,000) |

Neither threshold goes under 80,000: a worker's base plus a compaction's summary is already about 67k. The mid-turn threshold is
the process's `autoCompactWindow` setting (`--settings`), which Claude Code turns into a threshold of the window less 20,000 (the
output reserve) less 13,000 (its buffer): read from Claude Code 2.1.284 and measured there (`autoCompactWindow` 170,000 gives
`effectiveWindow=150000` in its debug log). So it reaches a session when its process next starts. A pilot session's system prompt
ends with `## Compaction (pilot)` and one line saying when it compacts; that line marks the arm in its transcript.

To read it, on each worker machine: `python scripts/compact-compare.py --since <deploy time> --ids`. Per arm and model: cache-read
tokens and list-price cost a call, a session and a request, compactions and their triggers, and quality after a compaction (in the
40 calls after it, file ranges read again and commands run again, against the 40 calls before it), DONE lines and follow-up
messages. Compare only sessions on the same effort (`worker.effort` changed on 2026-10-24, w2000) and the same model.

Before the pilot (beast, 2026-10-17..24, 135 Opus 5.5 worker sessions, measured with that script): 200k context a call, 52.4M
cache-read tokens and $18.79 at list price a session (median $10.45), 1.93 compactions a session at 242k on average; in the 40
calls after a compaction 1.80 re-reads and 13.1 repeated commands (2.37 and 18.3 in the 40 before it).

**Result, rolled out** (beast, 2026-10-24 08:03Z to 10-25 02:04Z, Opus 5.5 workers, both arms in the same hours and so on the
same effort mix; compact-compare.py, list price; measured):

| | Control (20 sessions, 1,971 calls) | Pilot (25 sessions, 2,798 calls) |
|---|---|---|
| Context a call | 142k | 94k |
| Cost per 1,000 calls: cache read / cache write / output | $27.89 / $17.52 / $10.95 | $18.36 / $20.20 / $10.33 |
| Cost a call | $0.052 | $0.048 |
| Cost a session, mean (median) | $5.56 ($4.11) | $5.47 ($4.18) |
| Pilot against control at the same session length | | -17% (sessions over 140 calls -24%, under 80 calls +2%) |
| Compactions a session | 0.50, at 212k | 1.56, at 141k |
| In the 40 calls after a compaction (before it): re-reads, commands run again | 0.00 (0.00), 0.10 (0.00) | 0.05 (0.05), 1.38 (1.36) |
| DONE line | 15 of 20 | 17 of 25 |

Cache reads fall a third a call; each compaction writes the base and its summary to the cache again (cache writes cost 40
times a read), which takes back about a third of that. Pilot sessions ran longer (112 calls against 99, one of 367), so the
mean per session hides the saving: "at the same session length" fits the control's cost to a*calls + b*calls^2 and prices each
pilot session on it. The pilot's extra follow-up messages (5.4 a session against 3.1) were FF Factory's own resumes (ledger
notices, check-ins, the "Compacted" line), not people's corrections: 27 of one session's 31 were ledger notices. A compaction's
own summary call writes no transcript line, so it is left out of both arms (a guess: about $0.13 each, $0.14 a session more in
the pilot). So `worker.earlyCompactPilotPercent` defaults to 100 (w2002); set it under 100 for a control arm again.

### Shell output over 10,000 characters goes to a file (w2002)

A worker's shell results are 24% of what its later calls re-read (beast, 2026-10-17..24, each result's characters times the
calls after it before the next compaction, measured). Claude Code's `bashOutputMaxChars` (default 30,000) is how much of a
command's output the model gets inline; past it the whole output is saved to a file and the model gets a preview of about 2,200
characters with the path. Workers run with 10,000 (`WORKER_BASH_OUTPUT_MAX_CHARS`, their `--settings`). If nothing saved were read
back, that cuts 3.7% of all context tokens (8,000 would cut 5.1%, 15,000 1.5%; measured on the same week, with the preview's
measured median). 1% of results pass 12,900 characters, and of the 109 outputs saved past 30,000 in 14 days, 10 were read back
within the next few steps (measured).

## Model calls per session (w1478)

lothsahn, 2026-10-18: "why are there 200 calls at all? Typically you ask a worker to do something and it responds back. Why is
that not just one call?" Every tool step is a model call: the model has to see a step's result before it picks the next one, and
each call reads the whole context again. `scripts/worker-calls.ts` counts them from the CLI's transcripts on the machine it runs
on (main thread only, one call per assistant message id).

**Baseline: beast, 82 worker sessions, 2026-10-15..18 (measured, before w1478's changes)**

| What | Value |
|---|---|
| Calls a session | 249 (median 196); 46.3 a turn; 345k context a call |
| Calls with more than one tool | 9.9% |
| By kind | read 32.8%, other shell 24.1%, Unity 12.5%, waits 6.1%, mixed 6%, CI polls 3.8%, PR and git 3.6%, edits 3.3%, subagents 0.2% |
| In runs of five or more read-only calls | 11.8% (299 runs, 8.1 calls each) |
| Waits and polls back in under 30 s | 7.7%; 83 more were a leading `sleep` that Claude Code refused |
| PR routine | 164 PRs at 10.1 calls each (merge of the base, push, the w907 landed check, CI polls, merge) |
| Subagents | 2,353 calls at 105k context a call, against 345k in the main thread |
| Long sessions | the 10 sessions of 500 calls or more: 34% of calls and 47% of context-weighted spend |

Why not one call (measured by hand on 30 random pairs of back-to-back read-only calls): 25 of the 30 second reads used what the
first one found, such as a grep's line numbers fed to `sed -n`. Only about 5 could have run in the same call, which is about 3% of
all calls. Workers already chain independent reads inside one shell command; the repeats come from steps that depend on each other.

**The levers and what each should save (estimated from the table)**

| Lever | Where | Saving in main-thread calls |
|---|---|---|
| `ff-pr push` / `ff-pr merge` (machine/prFlow.ts) instead of about 10 git, gh and poll calls a PR | daemon shim, worker brief "Waiting on CI" | about 6 a PR × 2 PRs a session: **~5%** |
| A search of five or more reads goes to an `Explore`/`scout` subagent | brief "Fewer model calls", ff-agents skills | half the runs at 8.1 calls, their subagent calls at 30% of the context: **~3.5%** of spend |
| Wait in one blocking call, never a sleep-then-look call repeated or a refused leading sleep | brief "Fewer model calls" | half of the non-CI 3.9% short polls, plus 0.4% refused sleeps: **~2.5%** |
| Independent reads in one turn | brief "Fewer model calls" | half of ~3%: **~1.5%** |
| The Unity instance name in the brief (shared/unityInstance.ts), so a pin is one call | brief "Unity", the moved note | 339 `ReadMcpResourceTool` calls, 1.7% of calls: **~1.5%** |

Together about **13%** fewer calls (estimated), and about the same share of spend, since these calls carry near-average
context. The bigger lever the data shows is history, not call count: 47% of the spend is in the 10 longest sessions. That is
w1469's compaction at 200k ("Workers compact" above; a 34% pilot), and widening the pilot is the next step on it.

**Before and after.** On the same machine, once the portal deploy (the brief), the daemon update (the `ff-pr` shim) and the agent
tools publish (the skills) are live, give it at least two days of new sessions, then compare:

    node scripts/worker-calls.ts --until <deploy time, ISO>   # before (or --days 4 on a copy taken at the deploy)
    node scripts/worker-calls.ts --since <deploy time, ISO>   # after

Compare calls a turn rather than calls a session, since a session's length follows its task. Also compare PR-routine calls a PR
(about 5 or fewer expected), waits back in under 30 s (under 4% expected), calls in read-only runs of five or more, and
subagent calls. w1469's compaction changes context a call, not calls, so it does not move these counts. Run it on a Mac with
`--root` and `--match` for its sandboxes as well.

## Where a worker session's money goes, by phase (w2008, beast 2026-10-19..24, measured)

Read from beast's own transcripts (main worker threads, 148 sessions since the w1469 compaction; the scripts are the w2008
report's): one call is one assistant message id, its context is input + cache read + cache write.

- **After the first push is 56% of a session's cost** (research before the first edit 14%, implementing 30%). Mean context
  there is 173k; pushes per session: median 3, p90 9, max 33, so most sessions carry one PR's history into the next PR or fix
  loop. Inside that phase reads and searches are still 40%, git 12%, PR/CI 10%, edits 9%.
- **Keep the 1-hour cache.** Re-pricing the same calls with a 5-minute TTL costs $2,217 against $1,567 (+41%); misses after
  a 5-60 minute pause total $86 in 5 days, most of them the first call after a compaction.
- **Thinking stays in context.** A call with 2.8k thinking and 3.2k output grows the next call's context by a median 4.5k;
  7.3M thinking tokens in 5 days, about 13% of cost with their carry (estimate). Effort is the lever (w2000).
- **Exploration runs**: calls triggered by a read or search are 30-53% of most large requests' cost, and runs of five or more
  reads/searches in a row hold 20-30% of calls: the delegation rule's "five or more reads" case, done inline.
- **Waits**: about 110 pure timed waits (`until [ $SECONDS -ge $t ]; do sleep`) and 56 `gh pr checks` calls (which a
  fine-grained token cannot read) in 5 days; CI polling is 7% of calls.
- **Small**: images ($141 in 30 days carried), visible assistant text ($104 in 5 days), ToolSearch (967 `select:` against 81
  keyword queries; a keyword query adds 2.6k median, 10k p90).
- **Model**: re-pricing every Opus call as Sonnet saves 24% at most; the cache-read price is the same, so the context, not the
  model, is most of the bill.

### The phase split, measured as it runs (w2018)

The split above is now recorded live, so a pilot can be judged against it. Each agent's `ContextMeter` (shared/spend.ts)
charges each model call's list-price dollars to the phase the session is in when the call runs. A tool use then moves the phase
for the next call, in one direction only (`nextPhase`):

- **research** until the first Edit, MultiEdit, Write, NotebookEdit or Unity script edit;
- **implementing** until the first `git push`, `ff-pr push` or `gh pr create` (Bash or PowerShell);
- **after the first push** from then on.

The call that makes the edit or the push is charged to the phase before it. Each push is counted. A worker's turns land in its
session and in the requests it served (`phaseDays`, by UTC day, split like its dollars). Only workers are counted; orchestrators,
ops and standing agents are not.

- **spend_report** has a "By phase (w2018 ...)" section: all workers, each machine, and the top requests, for the report's window
  (`days`). Each line gives the dollars and shares by phase and the worker sessions with a reading. It also gives their pushes:
  the total, the median per session and the p90.
- **The request and session views** (the request's and the session's spend pages, `renderRequest` and `renderSession`) end with
  the same line over their whole record.
- **History before the deploy has no phase readings**, and a machine counts only from its daemon's update to this code. A window
  that starts before it reads low: compare windows that start after it.
- **`scripts/worker-calls.ts`** prints the same split from one computer's own transcripts, with the request that cost most (the
  first request id a session's brief names: a guess, where spend_report's attribution is exact). Use it for a before that
  predates the deploy.

**Baseline, the "before" for the Explore nudge pilot (w2014), the compaction pilot (w2002) and later changes** (measured on beast,
`node scripts/worker-calls.ts --days 8 --since 2026-10-17T09:02:16Z --until 2026-10-24T09:02:16Z`; worker sessions whose first
call is in that week; list price):

| | |
|---|---|
| Sessions, cost | 169 sessions, $2,704 |
| By phase | research before the first edit $310 (11%), implementing $779 (29%), after the first push $1,615 (60%) |
| Pushes per session | 682 in all; median 2, p90 9 |
| Calls | 39,322: 233 a session (median 136), 195k context a call |
| Reads | 10.6% of calls in runs of 5+ read-only calls; subagents: 6,293 calls at 102k context |
| Top requests (all after the first push 69-97%) | w1431 $183 (30 pushes), w1440 $115 (29), w1475 $110 (22), w1432 $81 (4), w1590 $77 (8) |

This week's 60% after the push is higher than w2008's 56% (148 sessions). The rules are the same; the windows differ. w2008
counted every call made from 2026-10-19 on. This counts the whole of each session that started in the week, including its
pre-compaction days from 10-17 to 10-19.

How to read a pilot against it: run the same command over a week that starts after the change, on the same machine, and read
spend_report's "By phase" for the fleet. A cut in after-push dollars that does not raise the dollars per merged PR is a win.
A smaller after-push share that only comes from more research or implementing is not.

### Read chains handed to a subagent, a pilot (w2014)

lothsahn, 2026-10-24: "nudge workers to hand long read/search chains to Explore". The exploration runs above are the game repo's
delegation rule ("a lookup you expect to need five or more reads") done inline. In a share of worker sessions
(`worker.readChainPilotPercent`, default 50, set_app_config; 0 off; by a hash of the session id drawn apart from the compaction
and terse-prose pilots, server/readChain.ts) the agent host adds a PostToolUse hook (server/readChainHook.ts): after the fifth
Read, Grep, Glob or read-only Bash call in a row on the main thread, one line, `five reads in a row: hand the rest of this search
to ff-agents:Explore or scout and keep the conclusion (CLAUDE.md, Delegation policy)`, once per chain. Any other tool call and a
new prompt start the count again; a subagent's own calls neither count nor reset it. A Bash call counts when every part of it
(split at unquoted `;`, `&&`, `||`, `|`) is a reader (cat, head, tail, sed without -i, grep, rg, find without -delete or -exec,
ls, wc, awk, read-only git subcommands, ...) or neutral (cd, echo), and nothing writes a file (`>` other than /dev/null); gh,
python, npm and the rest do not. A pilot session's system prompt ends with `## Read chains (pilot)` and one line, which marks the
arm in its transcript, and the line itself shows there as hook context where it fired. It reaches a session when its process
next starts, on a daemon of this version (an older daemon ignores the field).

To read it, on each worker machine: `python scripts/compact-compare.py --since <deploy time> --marker '## Read chains (pilot)' --ids`
(cost a call, a session and a request per arm), and cost per merged PR and reopens per arm from `spend_report` and the ledger for
those ids. Compare within one model and effort, and mind the other two pilots: each arm holds about half of each of them. The phase split above (w2018) is the before: the research share is where a nudge that works shows first.

### Merging green PRs with no model turn, a pilot (w2045)

lothsahn asked for "a Sonnet helper for CI waits and merges only", then chose, after the measurements below, "Have FF Factory
merge green PRs itself with no model; the worker reports before the wait". Measured on beast's worker transcripts, 2026-10-10
to 10-24 (the turn after an "is unblocked: ... CI on ... finished" resume, priced at Opus 5.5's rates with 1-hour cache
writes): 275 turns woken by green CI, about 20 a day; median 4 calls, a first call of median 177k tokens, 71 of them cold;
cost median $0.39, mean $0.84, $232 in all. 69 woken by red CI: median 12 calls, median $0.76. A Sonnet helper saves little:
Sonnet 5 reads cache at $0.20 per million, as Opus does (shared/spend.ts), so the same session switched to Sonnet saves nothing
and writes its context afresh, and a fresh Sonnet session starts at about 56k tokens (the median first call of 465 fresh
workers), about $0.25 a PR, saving about $0.14 (estimated). Merging with no model saves the whole green turn: about $8 to $16
a day on beast (estimated from the figures above), less the report the worker writes before the wait.

The mechanism: docs/orchestrators.md, "Merge on green, a pilot". To read it: the requests whose log carries
`merge-on-green pilot (w2045)` are the arm (and those whose log says `FF Factory merged ... with no model turn` merged that way);
compare cost after the first push and per request against the control requests in the same window, and count red PRs merged
(must be none) and the arm's hand-backs (red, or a merge refused). The fresh-session pilot (w2043) splits requests by
`fresh:`, so the two read as a 2x2.

The result, 24 h at 50% (2026-10-24 15:55Z to 10-25 15:55Z). Merges, all machines, from the portal journal (measured): FF
Factory merged 24 PRs on green for 23 requests (FinalFactory, final-factory-agents, ff-factory); every merged head's
pull_request runs had passed (`gh run list --commit`), so 0 red PRs merged; 3 red CI runs went back to their workers, as
designed (w2117's #2502 logged its hand-back twice, 2 minutes apart: a possible double resume, not traced); no merge refused
and no filed report refused. Cost, beast's transcripts only (measured): pilot 19 requests (14 pushed), control 18 (11 pushed);
per pushed request median $4.23 against $5.29, after the first push median $0.61 against $0.33 (mean $1.85 against $0.97, the
pilot's held up by one request that spent $15 after its push and never used the feature); a green-CI resume turn now costs a
median $0.13-0.14 in both arms (6 and 11 turns), well below the $0.39 of 10-10 to 10-24 (why: not checked); writing the report
before the wait cost about $0.10 a time (median, 8 sessions). 8 of 14 pushed pilot requests left a report. So the arms differ
by less than their noise; a merge with no model saves about $0.10-0.15 net (estimated), about $3-7 a day at 100%, and merges
as soon as CI ends. lothsahn, 2026-10-25: "Widen the merge-on-green pilot to every request (set it to 100)"; it is 100 since.
A worker cannot set a pilot's percent: only a person's own orchestrator can (set_app_config, docs/accounts.md), so a pilot's
switch on, widen and off are each a card to that person.

### A fresh session after each merge, a pilot (w2043)

lothsahn, 2026-10-24: "Do a pilot for one day". After the first push is 56-60% of a session's cost (above), and most sessions
carry one PR's history into the next step. In the pilot arm (`worker.freshAfterMergePilotPercent`, default 0: off;
set_app_config, 0-100; drawn by a hash of the REQUEST id, `fresh:<id>`, apart from the other pilots, so every session of a
request is in one arm and spend compares per request; server/freshAfterMerge.ts):

- **A request goes on in a fresh session.** A worker between turns whose one open request had a pull request merge during its
  session (`prs[].at`, GitHub's mergedAt, at or after the session started) does not get its next message (a CI or deploy resume,
  its own check-in, a person's or the dispatcher's word) in that context. SessionManager's `freshStart` hook, in `send` and in
  the queue drain, hands it to `Agents.freshStart`, which calls the w740 machinery, `startFreshSession` with `moveFrom`: a new
  session in the same sandbox and branch, on the request's person, its first message a short hand-off (the mark `Fresh session
  after a merge (pilot w2043)`, what merged, what is left in the old session's last word, the message quoted) plus the usual
  request as filed and handover (branch and git state). The old session's check-in and the ledger's gate resumes and held
  check-ins move to the new one (`Orchestrators.sessionReplaced`); the old one is stopped once free (`retireWhenFree`). Never
  mid-turn; a message with images, a gated request or a failed start goes to the old session as always.
- **A worker whose PR merged and that holds nothing open** is ended at its turn end, and the dispatcher's next request for it
  starts a new session even when related (message_agent's session choice says why).
- **The arm is logged**: `fresh-after-merge pilot (w2043): worker <id> for <request>, <pilot|control> arm` on each worker start,
  and each switch, in the portal log; the hash says the same at any time (`freshAfterMergeArm`).

To read it: spend_report over the day for the requests of each arm (cost per request, the "By phase" block, after-push dollars),
re-reads from `scripts/worker-calls.ts`, and lost-context rework from the ledger (reopens) and the fresh sessions' transcripts
(research the merged work had settled, done again).

**Result: dropped after one day** (2026-10-24 15:35Z to 10-25 15:35Z at 50%; set back to 0 on lothsahn's orchestrator's word,
"There's no further trial"). Measured unless marked:

- **Arms** (portal log, the arm lines): 56 requests in the pilot arm, 49 in the control. **11 switches** to a fresh session
  fleet-wide. **12 fallbacks**: the worker's sandbox had gone to another worker while it waited on CI (`no fresh session for
  worker ... (beast/slot3 is not ...'s any more`), so the message went to the old session. Plus 5 workers ended after a merge
  with nothing open, and a sixth that was mid-turn was left to stop once free. A rerun should start the fresh session in a free
  sandbox on the branch, the way a CI resume already moves a worker, or half its switches never happen.
- **Spend on beast** (`node scripts/worker-calls.ts --since 2026-10-24T15:35:00Z --until 2026-10-25T15:40:00Z --days 2 --top 0
  --json`, list price; 39 requests): pilot 18 requests, $60.96, mean $3.39, median $2.85, after the first push $4.29 (7%), 13
  pushes. Control 21 requests, $117.32, mean $5.59, median $4.35, after the first push $35.10 (30%), 29 pushes. **The gap is not
  the switch's**: it fired about three times on beast that day, and one control request (w2078) spent $15 after its push alone.
  The request mix decides a sample this small.
- **Per switch** (the three fresh sessions on beast against the sessions they replaced): a fresh session starts at 45-49k
  tokens of context. The old one stood at 66-88k after the earlier compaction (w2002). After a CI wait the cache is usually cold
  either way, so a switch saves about $0.30-0.50 (estimated), a few dollars a day at 11 switches.
- **Rework**: small. The fresh sessions made 8 calls (about $0.60, mostly log reads), 34 calls of new work (about $2.37), and
  17 calls that re-read only the merged PR's description. Reopens were not checked: a worker's read_work refuses other requests,
  and spend_report is an orchestrator's tool. Ask for a ledger-read grant before such a pilot ends.

## Transcripts: how long they are kept

**Seven days after the request closes**, a request that is open keeps them as long as it is open, a reopened request keeps them again.
(Lothsahn's note said "at least 7 days"; counting from the close rather than from the last write means a long request's
first worker is not pruned while the request still runs, and a short one is kept a week after it ended. `dataGuard.retainDays`.)
A session that served several requests is kept until the last of them is past it. A personal orchestrator's, the dispatcher's and
the ops worker's own conversations are never pruned (they are the chat). Before this change nothing pruned a transcript at all; only
`delete_sandbox` and the dashboard's delete removed one with its session, and `SessionManager.remove` now leaves the
transcript on disk while its retention runs (`keepTranscript`); the guard deletes it when it ends. The cost record never goes with a
transcript: `data/spend.json` keeps requests (with their title, kind and close time) and sessions, 1 to 2 KB each.

## The data guard (server/dataGuard.ts)

Runs 3 minutes after the portal starts and every `dataGuard.everyMinutes` (60). By how full the disk holding `data/` is:

| Disk used | Does | Why |
|---|---|---|
| under 50% (`gzipAtUsedPercent`) | nothing | lothsahn's reading: 4.4 GB of data on a 95 GB disk, 19% used. |
| from 50% | compresses (gzip -9, written beside, read back and compared, then the plain file removed) every transcript idle for a day (`gzipIdleHours`), biggest first | lossless; the store reads `.gz` (and search, and `agent_transcript`) and a session that is resumed gets its plain file back first. Compression is cheap, and it runs well before pressure. |
| from 75% (`pruneAtUsedPercent`) | deletes transcripts whose retention has ended, oldest first, until the disk is 5 points below 75% | only past the 7 days; never a running session's; never one that belongs to an open request |
| from 90% (`alertAtUsedPercent`) | if that was not enough, says so: the log and a host notice to the owner, at most once a day, with what it could free and what sits inside the window | it never deletes inside the window: a person decides (a bigger disk, a shorter `dataGuard.retainDays`) |

The percentages are guesses: nothing in the portal's data says what a good number is, and the disk is 95 GB. They rest on
(measured) beast's own Claude Code transcripts, which are the nearest thing to the portal's on hand: **0.26 GB a day**
(2026-10-03 to 09, from the lines' own timestamps; 0.15–0.43 a day), **gzip ratio 0.21** on their text lines (0.65 on the biggest
files, which carry base64 screenshots the portal keeps apart), so 7 days are about 1.8 GB plain and 0.4 GB compressed, 2% of 95 GB.
The portal holds every machine's agents, not only beast's, and its lines are clipped (tool results at 6,000 characters) and
carry no usage, so **the real figures need one run on the portal host**:

```
node scripts/transcript-footprint.ts <data dir>
```

prints today's size, the bytes written per UTC day (exact, by each line's own time), the mean of the last full days, the
projection at 7 days and the gzip ratio on a sample. `spend_report footprint:true` and the Spend tab show the same, less exactly
(file birth time). Set the three percentages in `config.json` as `dataGuard`; the defaults are 50 / 75 / 90, 7 days, 24 h, 60 min.

## Backfill

90 seconds after the portal starts, once, in the background (10 sessions then a short pause, newest first), `SpendStore.backfillSession`
reads each session's transcript that the record has not seen. Dollars are the recorded `costUsd` of the result lines, differenced
(the SDK's, as the portal stored them then); **tokens and the model split are estimates**: a turn's output tokens from the
characters the agent wrote (× 0.75), its cache writes from the characters it and its tools wrote (÷ 2.3), and what the dollars have
left as cache reads at the model's list price. Each backfilled turn is tied to its request by its messages' `[about]` line, the
ledger's links (for requests still in the ledger), the `wNNN:` title prefix, else `_unattributed`; all of it is in
`estimated`, shown as "backfilled or estimated: its tokens are estimates", and the Spend tab says how many sessions, turns and
dollars were backfilled and when. It never counts a turn twice: only events before the first one recorded live (`liveFrom`).
It cannot know a pre-existing session's cache split exactly, nor its context readings: none for backfilled turns.

## Limits

- A machine's daemon sends `usage` (tokens per model, context readings) only after it has this code; until then its turns are
  dollars only and estimated. `machine_update` (the ops worker) brings a machine up to date; the portal needs a deploy first.
- Attribution rests on the ledger's `links` and the messages. A message that names two requests for a worker in one go splits the turn
  evenly. An orchestrator turn that names no request is overhead, not any request's. A coordinator turn that names several is split evenly too: an estimate ("Coordination").
- The categories are by characters. Tool results are clipped to 6,000 characters in the transcript but counted whole by the meter (it sees them before the clip).
- A turn is tied to the messages its result answers (`answers`), so a message that arrives mid-turn belongs to the next turn. A new agent
  process whose totals started again (the SDK did not carry the saved ones) says so (`usage.restarted`), and its first turn counts in full.
  A daemon too old to send usage, at its first result on a session that already had turns, records $0 for that turn (the backfill skips it too).
- The guard compresses and the backfill reads on the pool and yield between files, but one big transcript parse is one blocking step (a few hundred ms).
- `data/spend.json` is never pruned (1 to 2 KB a request and a session; rewritten whole at most every 10 s). Prune it by hand if it grows past a few tens of MB.
- Prices (shared/spend.ts) weigh the shares and price the estimates; every dollar called measured is the SDK's.
- The first reading below is beast's alone (its Claude Code transcripts; no other machine's, and not the portal's orchestrators).

## First reading: beast, the last 7 days (2026-10-03 to 10, `scripts/spend-claude.ts`, measured)

Tokens per call are the API's own; dollars are those tokens at list prices (checked against the CLI's own totals, below). 206
sessions, 44,220 model calls: **$4,661** (cache read 16B tokens $3,178 = 68%, cache write 136M $994 = 21%, output 27M $489 = 10%,
uncached input 89k). The CLI's `cost-state` totals agree with the calls' list prices to the cent on every session from 2026-10-08
on (ratio 1.00, 1.00, 0.97 on the 10th, which is in progress); before 10-07 its totals are short (session 8c24c8d7: calls $265, CLI $13),
so the older days are the calls' arithmetic, which matches the CLI exactly where the CLI is complete.

By day and model: 10-03 Opus $701; 10-04 $790; 10-05 $792; 10-06 $944; 10-07 $450; 10-08 Sonnet $181 + Opus $127; 10-09 Sonnet $384 + Opus $48;
10-10 (part) Sonnet $174 + Opus $70. The drop is the 10-08 switch of workers to Sonnet 5.5.

Top requests by cost (beast only; a request is the one a session's first message names, or its `[about]` lines later; an old-format
brief ("Goal: …") that names only a related request can be tied to that one, so treat a title below as the session's, not as
certain; the portal's own attribution uses the ledger and is exact):

| # | Request | Cost | Sessions / calls | Mean context | Where its tokens went (share of its dollars) |
|---|---|---|---|---|---|
| 1 | `_chat`: two or three person-to-orchestrator chats from before the portal's orchestrators (not a request) | $445 | 3 / 3,292 | 464k | 1,834 calls after a message $293, machine tools $101 |
| 2 | w259 mass driver features (and a colour-picker session that names it) | $284 | 2 / 2,122 | 504k | own output 43%, base 24%, file reads 14%, search 5%, shell 4% |
| 3 | `_worker-no-id`: 17 workers whose brief names no request (before the numbering) | $266 | 17 / 2,638 | 325k | file reads $53, shell $39, search $38, Unity tools $37 |
| 4 | w256 landing-zone ghost | $218 | 2 / 1,695 | 488k | own output 44%, base 20%, file reads 15%, search 6% |
| 5 | w294 Unity's blocking editor dialogs | $136 | 1 / 867 | 467k | own output 36%, base 31%, file reads 16%, search 9%; $22 to write the context again after the cache went cold |
| 6 | w510 (and a ledger PR-state session that names it) | $106 | 2 / 852 | 449k | own output 37%, file reads 22%, base 19%, search 10% |
| 7 | w727 Steam Deck UI scale (w723 resumed) | $76 | 1 / 400 | 767k | own output 40%, base 20%, file reads 19%; 50 CI-poll calls $8 |
| 8 | w334 Plasma Bolt | $69 | 1 / 587 | 433k | own output 40%, base 26%, file reads 19% |
| 9 | w426 (the dispatcher's turns about it) | $68 | 1 / 681 | 336k | 437 calls after a message $48, machine tools $17 |
| 10 | w668 Command Core panel | $68 | 1 / 564 | 476k | own output 49%, base 15%, file reads 14%, Unity tools 7% |

By kind of work (titles are the session's opening, so "other" is large): other $1,742 over 66, ops $767 over 39, no request $756 over 5, bug fix $737 over 33,
feature $309 over 26, investigation $251 over 24, release $51 over 7, review $51 over 3.

Where the money goes inside sessions (context shares by characters, applied to the measured dollars): the agent's own output
and thinking, carried in every later call, 39% ($1,836); base 25% ($1,158; the median first call reads 54k tokens); file reads 14% ($671);
searches 6% ($267); messages 4% ($174); shell output 3% ($151); git 2% ($105); Unity tools 2% ($90); machine tools 2% ($87); builds and tests 1% ($68);
CI polling 1% ($26); re-reads 0.3% ($14). Calls by what made them necessary (the kind of result they follow; every call re-reads
the whole context): after a message 4,925 calls $997 (21%, $0.20 a call against $0.09 for the rest), after a file read 6,997 calls $706,
shell 6,331 $600, search 6,241 $517, Unity tools 5,617 $446, builds and tests 3,654 $381, git 3,368 $318, machine tools 2,667 $280, CI polling 2,860 $263.

### The biggest opportunities, each with its measured size

1. **Workers never compact, and long contexts are most of the money.** Calls that read more than 400k tokens cost $2,707 of the
   $4,663 (58%); more than 700k, $1,145 (25%); 59 of the week's 206 sessions ended above 400k. Compactions seen: 19 in 44,242 calls.
   Each call re-reads the whole context (cache reads are 68% of the money), so cost grows with calls × context. *Modelled* from the
   measured growth of every call (compact whenever the context passes the threshold, down to 85k = base + summary + files read
   again, the compaction's own call included): 150k saves $2,354 (50%), **200k saves $2,240 (48%, 468 compactions)**, 300k saves $1,866 (40%).
   On the last three days alone (workers on Sonnet since 10-08): $1,307 → $765 at 200k (saves $541, 41%). Orchestrators already
   compact at `orchestrator.compactAtTokens` (200k); workers have no equivalent (w740 notes it).
2. **A big context written again after a long wait.** 123 calls came after a pause of over an hour and wrote most of their
   context again: $363 for those calls, **$352 more than reading it from the cache (7.5% of the week)**, $2.82 a call against $0.09
   (last three days: $42 more, 3%). The waits are CI, builds and people. Compacting before a wait, or ending the turn on a request
   that waits and starting a fresh session after, removes it.
3. **Opus.** 84% of the dollars. The same calls priced as Sonnet 5.5: $3,921 → $3,258, **saves $664 (14% of the week)**; cache reads cost the same on the two ($0.20 a million), so the
   gain is writes and output. Since the 10-08 switch Opus is still $245 of $984 (the dispatcher's and orchestrators' chats, the nightly sentry's verifiers): repriced, those save about $100 over three days.
4. **Waiting calls.** Calls that follow a CI-poll, wait or Monitor result: 2,860 calls, $263 (5.6%); 50 CI-poll calls in w727 alone cost $8.
   `blocked_on` and `wake_me` already take a worker out of the loop; the $263 is the part that still polls.
5. **Orchestrator chats.** The person-to-orchestrator chats (`_chat`, three sessions): $445 over 3,292 calls at a mean 464k context (largest 968k), 1,834
   of those calls after a message ($293). They ran uncompacted far past the 200k default; the same threshold as in 1 applies.

What is small, measured, and not worth the effort: re-reading a range of a file already read: 288 re-reads, $14 (0.3%), 18 of them after a
compaction. Trimming the base context: every 10k tokens off every session's first call saves about $96 a week
(10k × 44,242 calls × $0.20 per million, plus one write per session), 2%. Thinking is a third of the output tokens (9.3M of 27M), about 3% of the money.

## Changing it

The portal's own `data/spend.json` is written like `work.json` (`SnapshotFile`, crash-safe, at most every 10 s). The format
version is 1; a field added later is optional. The record is not part of `state.json`.
