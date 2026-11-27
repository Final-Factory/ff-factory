- **message_agent links its request before it sends** (w6092, from w6071's review of #1357): a message parked on the
  worker's held Claude pool was never linked to the request it named, and once the worker's own request closed, a drain
  that lets only its running workers finish dropped it. The request is now linked first and Blocked on the pool with the
  rest. Needs a portal deploy.
