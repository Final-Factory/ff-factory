- **A timed leg's whole report reaches the worker Blocked on it** (w3105, asked by Ben). w3094's 7 KB DONE (a run table
  and eight JSON lines) reached w2895's waiting worker as "5795 chars left out": a session keeps only 1200 characters of
  its last turn (`reportClip`), and the resume quoted that. Now a hand-off request (a timed leg, a pair run, a request
  another is or was Blocked on the report of, or one whose report has a `For wNNN:` line) keeps its newest report whole on
  the ledger entry (`WorkItem.handoff`, up to 24,000 characters). The waiting worker's resume quotes it whole up to
  12,000 characters (else its `For <waiter>:` section on, with a pointer to the rest), a pair run's result quotes 8,000,
  and `read_work <leg>` shows it as "Last report in full". Ordinary turns keep the 1200-character cut. Docs:
  orchestrators.md ("A wait never closes a loop", "Workers read the ledger"). Tests: `handoffReport.test.ts`,
  `orchestrators.test.ts` (w3105).
