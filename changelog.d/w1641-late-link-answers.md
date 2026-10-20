- **A stalled update bundle download resumes instead of sinking the update or tools publish** (w1641): at the 8c66ee8 deploy
  beast's tools publish failed "beast did not answer the tools over its link in 5 minute(s)". Its daemon's bundle download had
  stalled at 6,962,988 of 18,549,629 bytes (20:53:30Z) and sat until undici's own body timeout (300 s with no byte) ended
  it as "terminated" (20:58:36Z), 16 s after the portal had given up. The daemon now notices a stall after 30 s and resumes
  from the bytes it has with a Range request (the portal already answers them), up to 6 tries within 8 minutes, logging each
  retry with its cause (`UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`, ...). The portal waits 12 minutes for the daemon to take an
  update or tools publish over its link (was 5), longer than the daemon's own limits, so a refusal arrives while it still waits.
- **A daemon's answer that comes after the portal stopped waiting is logged with its reason** (w1641): a late
  `self_update_ack` or `daemon_control_result` was dropped without a trace. The journal now says `machine <id>: a late answer
  to <what> (call <id>): it refused it: <why>, <time> after it was sent; the portal had given up after <time>`, and an answer
  to no known call is logged too. Needs a portal deploy (the download fix reaches a machine with its daemon update).
