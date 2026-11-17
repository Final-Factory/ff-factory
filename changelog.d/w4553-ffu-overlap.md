- **The dispatcher no longer starts two ffu rows on the same code at once** (w4553; lothsahn: "Dispatcher: don't run two ffu
  rows on the same code at once"). From 2026-11-15 12:00Z to 11-17 11:00Z, 7 of the 8 not-mergeable merge-on-green failures
  were ffu pull requests, rows of one fan-out editing the same files. start_agent now compares an ffu row's files (the paths its
  title, brief and start prompt name) with the open ffu pull requests updated in the last 72 h and the
  other ffu rows in flight (their PRs' files, else their own expected files). On an overlap it holds the row Blocked on that PR
  merging, or on that request closing when it has no PR yet, and tells the dispatcher why; the row comes back when the gate
  clears. Files a tenth of the last 100 merged ffu PRs touch (hubs such as `sector.rs`) never count, so ffu work is not
  serialised: their conflicts are sorted-list ones, which ffu's keep_sorted handles (w4548). `override_duplicate` starts a row
  anyway; a GitHub read that fails starts it (logged). Code: `server/ffuOverlap.ts`.
