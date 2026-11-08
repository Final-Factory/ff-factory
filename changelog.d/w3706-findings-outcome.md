- **Every request keeps a Findings / outcome record** (w3706, lothsahn: "every time a worker finishes the ledger gets
  updated for a workitem about its findings or outcomes before the workitem is closed. That way you can look things up
  quickly without the full transcript"). Each report a worker ends a turn with is kept whole (up to 3,000 characters, the
  record under 9,000) on the requests that turn was on, across hand-offs and moves; every close, whatever made it,
  writes the final outcome (the close note plus the last worker report) before the request is saved. `list_work` with an
  id and `read_work` show both in full. Docs: orchestrators.md, "Findings and outcome (w3706)". Tests:
  `w3706Findings.test.ts`.
