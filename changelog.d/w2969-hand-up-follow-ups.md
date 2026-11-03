- **Follow-up requests a worker writes now get filed** (w2969, Ben: "Also fix the harness for whatever caused the dragon
  work to not start"). Workers cannot file requests, and w2194's worker said so in a report ("I couldn't file the five
  build requests myself, because none of my tools can create a request") that reached nobody who could file, after which
  the ledger cleanup closed w2194 on its DONE and the five approved dragon stages sat unfiled for five days. Workers now
  have `hand_up_requests` for such briefs, and a report saying it could not file them counts the same: the requester's
  orchestrator is sent `[follow-ups to file]` with the briefs and its person's newest note, and the request stays open,
  its DONE kept, until each is filed with `related_ids` naming it or its person closes the request. The dispatcher is told workers never file follow-up work. Docs: orchestrators.md ("Waiting, Queued,
  Blocked", "Where messages go", "Workers read the ledger"). Tests: `w2969HandUp.test.ts`, "w2969: the w2194 dragon
  case" in `orchestrators.test.ts`.
