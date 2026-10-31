- **A pair run reads "no menus" as no menu clicks, can be re-marked, and a placement fork never reaches a person** (w2648,
  lothsahn: w2631, the 3-leg pair run for w2622, sat about 3 hours). `request_pair`'s own `menus` field rules; its words are
  read only without one, and a mention its own clause rules out ("no menus", "no Steam, no menus", "doesn't click any menu",
  "without clicking") counts as none, for the Steam reader too (`shared/mentions.ts`). `menus: "none"` is kept on the run
  (`WorkPair.noMenus`), so the dispatcher's queue no longer reads the words back. A run whose legs never started is
  re-marked: the worker asks `request_pair` again with `legs` or `menus`, the dispatcher passes `decide_work` `pair_legs`
  and the new `pair_menus` with any action (queue on a Queued run only re-marks it). `decide_work ask` and
  `waiting_on_person` refuse a card whose answers differ only in machines, legs, sandboxes or waiting
  (`placementForkProblem`, after w2147), naming the answer that starts now; the dispatcher's brief says so. Docs:
  machines.md, orchestrators.md. Tests: `w2648PairMarks.test.ts`, `orchestrators.test.ts` (w2648).
