- **Reports: a design or an analysis a person asked for is kept on the portal** (w2541, lothsahn: "Show these reports in
  the UI somewhere like you can see work items, and make sure theyre tagged with the operator that requested them"). A
  worker files its result with `file_report` (Markdown with its stills and clips, revised with its id; every older
  revision stays); orchestrators and workers find them with `list_reports` and `read_report`. A request marked with
  `report <kind>` (by its person's orchestrator in `request_work`/`update_work`, or by the dispatcher in `decide_work`)
  refuses its DONE until one is filed. The new Reports tab searches and filters by kind, operator, request and date;
  each report has its own page, and a request links to its reports. Kept in `<dataDir>/reports/`. Docs: reports.md.
  Tests: `reports.test.ts`, `orchestrators.test.ts` (w2541), `e2e/reports.spec.ts`.
