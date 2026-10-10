- **A waited-on pull request that cannot get CI wakes its worker, and a push that did not land is caught** (w907, lothsahn:
  "Yes, file that and fix the CI merge clash"). w890's PR #283 sat an hour behind a `ci:` wait: its push after merging main
  had silently failed, the PR conflicted with main in CHANGELOG.md, and GitHub runs no CI on a conflicted PR. The blocker watch
  now reads each waited-on PR's head and mergeability (Pull requests: read only) and clears a `ci:` gate at once, resuming
  the worker with "PR #N conflicts with main (CI can't run): merge main in, resolve, push, and wait again", when the PR
  conflicts and no check has started, or when no CI run exists for its head 10 minutes after the portal first saw it (a worker's
  own `pr:` gate on a conflicting PR too). `blocked_on` takes `head` (the commit just pushed) and refuses a `ci:` wait whose PR
  conflicts or whose head is another commit; without `head` it warns. Changelog notes are now one file each in `changelog.d/`
  (folded in by `npm run release`), so they stop conflicting. Needs a portal deploy (docs/machines.md "Waiting on CI").
