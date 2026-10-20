- **The Waiting on input and Intake cards ask one clear question** (w1597, Ben: "just ask the question clearly, give me the
  option selections and thats it"). Each card shows the request's title, one question (several decisions are asked one at a
  time), 2 to 4 full-sentence answers as buttons with the recommended one first and marked, a box for a free answer, and its
  stills and clips as thumbnails that open full size. Pull requests, ids, the dispatcher's restatement, the report and the
  evidence sit behind one Details link, with file names instead of paths. A click answers exactly as the same words typed do.
  The source changed too: `waiting_on_person` takes `questions` and `decide_work ask` requires them (one plain question per
  decision, 2 to 4 answers, a recommended one, no paths, PR lists or ids: `checkAsks` refuses those); a free-text question
  from before (or from a machine daemon not yet updated) is shown cleaned with the free answer box. Docs: orchestrators.md
  ("The question card"). Tests: `questionCard.test.ts`, `orchestrators.test.ts` (w1597), `e2e/intake.spec.ts`.
