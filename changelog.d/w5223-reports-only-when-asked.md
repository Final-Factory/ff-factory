- **Reports only when a person asks** (w5223, lothsahn: "I really only want it when I ask for one"; "we need a dramatic
  reduction, not a tweak"). Measured: 125 reports in the week to 2026-11-23, about 16 a day. Now a report is for people
  only when its request's mark came from a person's own turn, its worker names a review (`file_report review`), or it is
  a cost estimate (always shown: "Please make sure the cost remains unhidden"). Anything else is a worker note: workers
  still find it with `list_reports`, people do not see it by default. The Reports tab and an orchestrator's
  `list_reports` show the reports for people; the **Worker notes** chip (or `all: true`) adds the rest. The dispatcher
  no longer marks requests for a report (a mark of its, or one made outside a person's turn, holds no DONE), and the
  worker and orchestrator briefs say an investigation or a question is answered in the final message. Older reports get
  their audience once at the portal's start (logged). Docs: reports.md. Tests: `reports.test.ts`,
  `orchestrators.test.ts` (w2541, w5223).
