- **The Intake tab shows every request number on a phone, and folds what waits on nobody** (w2143, lothsahn: "In the
  intake, you can't see any of the workorders numbers in the screen on a phone ... Also, the intake is showing things that
  auto approved. Why show it if approved?"). A ledger row's number sat at the end of its one-line state, which a phone cut
  off with "…"; it now has a column of its own above the row's age (the Requests tab's rows too). A waiting card shows its
  number in its info line, linked to the request. Auto-approved requests leave "In the ledger" for a folded
  **Auto-approved** section (its line names any that stalled), and **Closed automatically** is folded too. Docs: intake.md
  ("What people see"). Tests: e2e/intake.spec.ts.
