- **A daemon's answer to an update survives a link drop** (w1641): at the 450f7d53c rollout the portal VM's Tailscale
  restarted 4.5 minutes into beast's update (22:26:01Z) and every machine's link was down for 30 s; the rollout then said
  only "beast did not answer the update over its link in 12 minute(s)". The daemon dropped an answer the link could not
  carry. It now keeps an update or restart answer 30 minutes and sends it again after the next hello when it was not sent
  or was sent less than a minute before the link dropped; the portal ignores a repeat and takes a job's report as the
  answer too.
- **The portal logs every update bundle it serves** (w1641): `machine <id>: the update bundle went out in <t> s (<rate>)`,
  or `was cut after <n> of <size> bytes`, so a daemon's "terminated" has the portal's side beside it.
