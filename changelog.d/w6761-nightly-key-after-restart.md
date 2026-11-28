- **Nightly key after a portal restart** (w6761): a nightly run's worker that FF Factory starts again after a portal
  restart now gets an extra nightly key (`nightly-run.<time>`), so its night can still report. Before, it got none: the
  key lives only in the portal's memory, and on 2026-11-28 the worker started after the 09:06 UTC restart printed "NOT
  DELIVERED". The key the first worker was given stays valid, and the next night's fire revokes every extra key.
