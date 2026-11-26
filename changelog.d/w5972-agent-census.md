- **A daemon's agent-cap refusal names the agents it counted, and the portal warns when its count of a machine differs
  from the daemon's** (w5972, warn only). On 2026-11-26 placement counted beast at "2 of 6" and sent w5892 there.
  beast's daemon then refused it and four other starts, at "6 agents", naming none. The refusals now end with
  `counted: <id> (<sandbox>, <status>[, no process])`. Each daemon's `stats` carry the list it counts. The portal logs an
  `agent count:` warning by session id when the two counts stay different for over a minute, and one line when they
  agree again. Nothing is stopped or placed by it. Needs a portal deploy and the daemons' update; an older side ignores
  the new field.
