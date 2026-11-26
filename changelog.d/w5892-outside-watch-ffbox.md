- **FFBox watches the portal from outside, not m5** (w5892, lothsahn: "run 3 on ffbox"). While FFBox's link is set up
  it is the default outside watcher: the portal sends it the ntfy topic over the connector (`outside_watch`), FFBox's
  ffwatch checks `/api/health` every 60 s and alerts after 3 misses, and reports back (`outside_watch_status`), which
  `system_status`'s "Outside watchdog" line shows. No ping or Wake-on-LAN from FFBox (not on the tailnet). The machines'
  daemons are told they do not watch, so m5's copy is deleted when it next connects. Needs a portal deploy and ffbox
  connector 2.11.0.
