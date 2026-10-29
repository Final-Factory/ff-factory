- **A report that waits on a person is a person's wait, and their answer always resumes its worker** (w2495, lothsahn).
  w2443's worker wrote "waiting on lothsahn to click Pause in FF Factory's tray on LothLaptop for the live test"; the ledger
  read it as a wait on a portal deploy (it names FF Factory) and held lothsahn's answer "while w2443 was blocked again on a
  portal deploy", so the live pause test stalled with LothLaptop paused (2026-10-29). Now a still-open line that waits on a
  person (by name, one of the request's people, or "a person") is never made a gate, whatever product it names, and a
  "<who> to <do>" before the product name is not a wait on FF Factory. A person's `[answer]` to a `[needs you]` is never held
  by a gate: it clears the gates the ledger read from that worker's own report and leaves the ones set with `blocked_on` or
  `decide_work` (w754). "blocked on the portal deploy of PR #752" is still a deploy wait. Test: `orchestrators.test.ts`
  (w2495).
