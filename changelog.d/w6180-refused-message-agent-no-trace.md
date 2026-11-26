- **A refused message_agent leaves no trace** (w6180, finding B of w6111's review of #1372): the request is linked as
  soon as the send returns, not before it, so a send refused outright sends no notice, closes no question card and
  releases no other session. A message parked on a held Claude pool is still linked before the queue's first pass, and
  Blocked on the pool with the rest. Needs a portal deploy.
