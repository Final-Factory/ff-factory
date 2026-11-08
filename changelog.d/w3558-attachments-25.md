- **A hand-over takes up to 25 files, and the limit is a setting** (w3558, lothsahn: "What is the 10 attachment limit? Can we
  raise it to 25?" and "Please make this also a configurable setting in fffactory that can be updated"). New config
  `attachments.maxPerMessage` (default 25, 1-100, `set_app_config`, live in the server's check; the tools' list limit follows
  at each agent's next process start) replaces the fixed 10 of messages, `request_work`, `start_agent`, `message_agent`,
  `update_work` and `orchestrator_attach`. A `work_id` hand-over now sends the request's own files in full and caps only the
  ids the call adds, so a request that gathered more (w3546's 16 from joined FFBox threads) can be started and linked. FFBox
  dev hand-overs (`providers.ffbox.devRequests.maxFiles`, default and most) and escalations take up to 25 as well.
