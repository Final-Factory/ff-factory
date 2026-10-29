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

## Which requests need one

A request is marked `report: { kind, at, by }` (`WorkItem.report`) in either of two ways:

- its person's orchestrator, filing it with `request_work report <kind>` or later with `update_work report <kind>`
  (`false` takes the mark back);
- the dispatcher, with any `decide_work` action and `report <kind>` (`Orchestrators.decide`: the decision runs first,
  so a refused decision leaves the mark as it was).

A marked request's DONE is refused until a report is filed for it (`reportProblem`, `server/ledgerRules.ts`), and the
refusal names `file_report`. Filing one links it on the request (`WorkItem.reports`, `Orchestrators.reportFiled`).

**The brief rule** (worker brief, `server/agents.ts`): when a person asked for a design or an analysis, its result is a
report, filed with `file_report` and revised with its id when the result changes. The dispatcher's and each personal
orchestrator's brief carry one line each on marking such a request.

## Tools

| Tool | Who | What |
|---|---|---|
| `file_report` | workers | file a report for one of its open requests (title, kind, body as Markdown, note, attachments), or revise one of its own requests' reports with `id` |
| `list_reports` | workers, dispatcher, personal, remote | one line each, newest first; `query` (every word must match the title, text, kind, request or operators), `kind`, `request`, `person`, `since`, `until` |
| `read_report` | workers, dispatcher, personal, remote | one report in full; `rev` for an older revision |

All three are in the `ledger` group (`server/toolManifest.ts`).

## The portal

- The **Reports** tab (`web/src/components/Reports.tsx`, `ReportsTab`): search (server side, `GET /api/reports/search`),
  the operator, the request, a date range, and kind chips with counts. Each row shows the title, kind, operators, request,
  revisions and a snippet.
- A **report page** (`#/dispatcher/r12`, `ReportPage`): the Markdown with its stills and clips, the operators, a link to
  the request, the revision picker (`GET /api/reports/r12?rev=N`) and the attachments.
- A request's row shows its reports, or "Its result is a report (…); none filed yet." while one is due.
- Live updates ride the `report` server event.

## Not moved: the older .md files

The ad-hoc `.md` files already in the data folder stay where they are. `w643-migration.md` is a migration marker
(`server/waitsMigration.ts:68`), not a report.

Tests: `server/reports.test.ts` (store, revise, media, list, search), `server/orchestrators.test.ts` ("w2541: …", the
mark, the DONE hold, the link, the tools), `e2e/reports.spec.ts` (the tab, the filters, the page, the request link).
