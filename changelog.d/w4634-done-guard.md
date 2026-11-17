- **decide_work changes a flag without an action, and done refuses a placeholder close** (w4634; lothsahn: "the dispatcher can
  never close a request as done with placeholder or empty text, or when no worker ever reported on it"). On 2026-11-17 at
  22:21Z the dispatcher closed w4592, the urgent 1.0.0.50 release that no worker had run on, as done with the note
  "placeholder", only to clear its timed flag: `timed` and `report` rode only beside an action (and the docs said "any
  action"). It had done the same to set the report flag on w4611, w4229, w3733 and w2621. Now `action` is optional: with
  none, only `timed`, `report` and `pair_*` change. `done` refuses an empty or placeholder note everywhere, and on a request
  no worker ever reported on or sent a DONE for it needs the reason (the request or PR that did it, or why nothing is
  needed); a refused decision leaves its flags as they were. Tests: `server/w4634DoneGuard.test.ts` and the w4634 case in
  `server/orchestrators.test.ts`.
