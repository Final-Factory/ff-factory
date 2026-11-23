# Reports (w2541)

A report is the written result of a design, an analysis, a profile, an investigation, a root-cause write-up or research
that a person asked for, kept on the portal beside the ledger. lothsahn's words: "Show these reports in the UI somewhere
like you can see work items, and make sure theyre tagged with the operator that requested them."

## What is kept, and where

`<dataDir>/reports/` (`server/reports.ts`, `ReportStore`):

| Path | What |
|---|---|
| `seq.json` | the last number given out; an id (`r1`, `r2`, …) is never given twice, even after a report's folder is gone |
| `r12/report.json` | the summary: title, kind, the request (`workId`, `workTitle`), its operators (`requesters`), created and updated times, the revision history (number, time, worker session, note), attachments |
| `r12/rev-N.md` | the text of revision N, written once and never rewritten: a revision adds a file, so every older text stays readable |
| `r12/media/…` | copies of the stills and clips the text shows |

The operators on a report are the request's `requesters` when it is filed or revised, never the worker's name.

**Kinds** (`REPORT_KINDS`, `shared/types.ts`): analysis, profile, investigation, root-cause, design, research, other.

**Media.** A still or clip the Markdown shows from review media (`publish_review`) is copied into `media/` when it is
filed and its link is rewritten to `/api/reports/<id>/media/<name>`: review media is deleted after 14 days
(`server/mediaRetention.ts`) and a report is kept. Any other local path is left as written and named back to the worker
("Not kept"), so it publishes and revises. The text is redacted (`redactValue`) before it is stored.

**Attachments** (`publish_attachment` ids) filed with a report are held as long as it is: `AttachmentStore.prune` skips
`ReportStore.attachmentIds()` (`server/attachments.ts`, `keep`).

## Only when a person asks (w5223)

lothsahn, 2026-11-23: "There are so many reports. ... I really only want it when I ask for one. If the reports help the
workers, can we have a filter so I only see requested ones by default?", "If the workers truly need me to review
something, like the cost, and it's more than a question, a report is great", "Please make sure the cost remains
unhidden. I need to review the FFU costs." and "I just want the worker to know we need a dramatic reduction, not a
tweak". Measured before the change (list_reports, search_transcripts): 125 reports from 2026-11-16 to 11-23, about 16 a
day; 54 from requests an orchestrator marked at filing (many a question or an investigation, w5181 for one), 8 from the
dispatcher's marks (players' Discord questions among them), 63 from requests with no mark.

Every report has an **audience** (`ReportSummary.audience`, `audienceWhy`; `audienceOf` in `server/reports.ts`):

- `people`: the request carries a mark a person asked for (`WorkItem.report.asked` not false), or the worker names the
  review a person must make (`file_report review`), or it is a **cost estimate** (`COST_SUBJECT`: cost, spend, budget,
  price, a `$` amount in the title or the review), which always shows;
- `workers`: anything else, a worker note. Workers still list and read it; people do not see it by default.

A revision may raise a worker note to people, never hide one people saw. Reports filed before w5223 got theirs once at
the portal's start (`backfillAudienceOf`, `server/index.ts`): people when a cost estimate, when the request is gone from
the ledger, or when its mark was made by a person's orchestrator in a turn of theirs (`asked`, else `humanAsked`); a
worker note when the request had no mark, the dispatcher's mark, or a mark outside a person's turn. The portal log says
how many: `reports: audience backfilled (w5223): N for people, M worker notes`.

## Which requests need one

A request is marked `report: { kind, at, by, asked }` (`WorkItem.report`) by its person's orchestrator, filing it with
`request_work report <kind>` or later with `update_work report <kind>` (`false` takes the mark back). `asked` is whether
the turn came from the person (`turnFrom ?? lastFrom === 'human'`). The brief tells the orchestrator to mark only when the
person's own words ask for a report, a write-up or a design to review, or the result is a cost estimate they must review;
a question, an investigation or a diagnosis is answered in the worker's final message, which it relays.

The dispatcher's `decide_work report <kind>` still works (`Orchestrators.decide`: the decision runs first) but records
`asked: false`, and its brief tells it to mark none. A mark with `asked: false` asks no report of the worker
(`reportRule`, `server/work.ts`) and holds no DONE.

A request marked by a person's ask refuses DONE until a report is filed for it (`reportProblem`,
`server/ledgerRules.ts`), and the refusal names `file_report`. Filing one links it on the request (`WorkItem.reports`,
`Orchestrators.reportFiled`).

**The brief rule** (worker brief, `server/agents.ts`): file a report only when the request is marked, or a person must
review something that is more than a question (`review`; a cost estimate always). An investigation, an answer, a
diagnosis or a fix is no report: its findings go in the final message, the PR and the repo's docs. A report filed anyway
becomes a worker note, and `file_report`'s answer says so.

## A design's go to build (w4739)

r290 (fix 5) measured 9 d 1 h between the finished multi-select design (r87, w3031) and the go to build it, offered in chat
("say 'file the w3031 implementation'") with no card. So:

- **Open questions are read from the report.** A design's report ends with an `## Open questions` section: `None.` once
  every one is answered, else each question as a list item (a bold `**Open questions:**` line works too).
  `openQuestionsOf` (`server/reports.ts`) reads it on every filing and revision of a design report and keeps the list on the
  request's link (`WorkItem.reports[].openQuestions`: `[]` none left, absent when the report has no such section).
- **The close asks the go.** When a request with a design report closes on its DONE (`Orchestrators.closeOnDone`,
  `designClosed`), its people's orchestrators get `[design closed] wNNN …` (`server/designGo.ts`, `designGoAsk`): ask the go
  with ask_person, "File the build of <design> now?", "Yes, file the build now" recommended; on yes, file the build with
  request_work naming the design in `related_ids`. Open questions still listed are asked first; a report with no section is
  read first. Nothing is sent when another request already names the design in its related ids (its build is filed, as a
  hand-up's stages are, w2969); the request's log says which.
- **Questions together.** The worker brief tells a design's worker to ask all of its open questions on one card (one
  `waiting_on_person` call with every one in `questions`), never one at a time or in chat, and never to offer the go in chat.

Tests: `server/designGo.test.ts` (the section reader on r87 revision 4's own text, the message), `server/orchestrators.test.ts`
("w4739: the w3031 replay", and no card when a build already names the design or the report is not a design).

## Tools

| Tool | Who | What |
|---|---|---|
| `file_report` | workers | file a report for one of its open requests (title, kind, body as Markdown, note, attachments, `review`: what a person must review), or revise one of its own requests' reports with `id` |
| `list_reports` | workers, dispatcher, personal, remote | one line each, newest first; `query` (every word must match the title, text, kind, request or operators), `kind`, `request`, `person`, `since`, `until`; workers see worker notes too, orchestrators only the reports for people unless `all` |
| `read_report` | workers, dispatcher, personal, remote | one report in full; `rev` for an older revision |

All three are in the `ledger` group (`server/toolManifest.ts`).

## The portal

- The **Reports** tab (`web/src/components/Reports.tsx`, `ReportsTab`): search (server side, `GET /api/reports/search`),
  the operator, the request, a date range, and kind chips with counts. Each row shows the title, kind, operators, request,
  revisions and a snippet. It shows the reports for people; the **Worker notes** chip (saved in the browser,
  `ffsb.reports.notes`) adds workers' notes, marked "worker note" (search passes `all=1`).
- A **report page** (`#/dispatcher/r12`, `ReportPage`): the Markdown with its stills and clips, the operators, a link to
  the request, the revision picker (`GET /api/reports/r12?rev=N`) and the attachments.
- A request's row shows its reports, or "Its result is a report (…); none filed yet." while one is due.
- Live updates ride the `report` server event.

## Not moved: the older .md files

The ad-hoc `.md` files already in the data folder stay where they are. `w643-migration.md` is a migration marker
(`server/waitsMigration.ts:68`), not a report.

Tests: `server/reports.test.ts` (store, revise, media, list, search), `server/orchestrators.test.ts` ("w2541: …", the
mark, the DONE hold, the link, the tools), `e2e/reports.spec.ts` (the tab, the filters, the page, the request link).
