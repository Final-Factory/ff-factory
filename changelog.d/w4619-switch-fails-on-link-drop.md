- **A branch switch or a save no longer holds its caller for 10 minutes when the machine's daemon drops its link** (w4619,
  found in w4596's pair-run speed-up: lothsahn, "file any subsequent findings as high priority fixes and just get them going").
  On 2026-11-17 the dispatcher's `switch_branch` of m5/slot2 went out at about 11:09 MST just as m5's daemon was updated over
  its link (dropped 11:09:28); the daemon never answered, the call sat to its 10-minute timeout at 11:19, and the capacity
  ping of 11:15 that named the urgent pair run w4609 as fitting biscuit/slot3 waited behind that dispatcher turn: w4609 was
  placed at 11:20, about 5 minutes late. A daemon's link that drops now fails its pending switches and saves at once,
  saying the outcome is unknown and that list_sandboxes shows the branch, and the journal records it ("answered it as
  unknown (w4619)"). Tests: `machines.test.ts` (w4619).
