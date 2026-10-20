- **A conversation's own closed request no longer answers its next FFBox hand-over** (w1637, lothsahn: "Why did Max
  respond twice here?", then "Yes, file the FFBox fix for both"). FFBox now hands a conversation over again once the
  request it was linked to is done, declined or cancelled, and a dev request's dedup leaves out the requests filed from
  that same conversation that are no longer open, so #ask-assistant conversation 1163's next question would be filed
  rather than answered "already fixed" from w1635. An open one still joins. Docs: ffbox.md ("Dev requests"). Tests:
  `devRequests.test.ts`.
