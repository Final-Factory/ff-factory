- **A request whose worker is stopped until its own check-in, on no machine, shows Sleeping, not Working** (w2428; lothsahn:
  "If it's not on a machine and it's not actively doing work it shouldn't be working"). w2014 read "Working (71ecf40d stopped
  until its check-in tomorrow 16:04 UTC)" while 71ecf40d had released its sandbox and ran nothing; it now reads "Sleeping
  (until tomorrow 16:04 UTC at 71ecf40d's check-in; ...)". Sleeping needs every worker of the request stopped (no process,
  so no agent slot, job or bench ticket), a check-in still ahead with no message queued, and no sandbox kept. A worker alive
  between turns, or stopped but still keeping its sandbox, stays Working; a check-in that has come due is Working for its
  2-minute grace and then Stalled when nothing resumed it. The dashboard's request filters and `list_work`'s `state` filter
  take `sleeping`.
