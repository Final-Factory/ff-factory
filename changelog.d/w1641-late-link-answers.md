- **A daemon's answer that comes after the portal stopped waiting is logged with its reason** (w1641): an update, tools
  publish, restart or unload over a machine's link whose answer (`self_update_ack`, `daemon_control_result`) came after its
  timeout was dropped without a trace, so beast's tools publish at the 8c66ee8 deploy said only "beast did not answer the
  tools over its link in 5 minute(s)". The journal now says `machine <id>: a late answer to <what> (call <id>): it refused it:
  <why>, <time> after it was sent; the portal had given up after <time>`, and an answer to no known call is logged too.
  Needs a portal deploy.
