- **A size or limit slip in an MCP tool call is fixed and warned about, not refused** (w1869, lothsahn: "Analyze your recent
  tool failures and make it so they don't happen in the future"). `ask_person` refused an option label over 90 characters and
  `agent_transcript` refused `last` below 5, each costing the model a turn. Now a long label is cut at a word with "…" and its
  full text goes in front of that option's description (also for `waiting_on_person` and `decide_work` ask), and a count or
  page size (`last`, `limit`, `offset`, `lines`, `top`, `days`, `passes`, `requests`) outside its range is moved to the nearest
  end, on `agent_transcript`, `orchestrator_transcript`, `search_transcripts`, `spend_report`, `cleanup_log`, `max_activity`,
  `ffbox_activity`, `unity` (log), `read_work`, `portal_logs` and `list_ffbox_files`. The answer ends with a `WARNING:` saying
  what was changed (`server/forgiving.ts`). Texts that guard against stuffing, ids, enums and settings (timers, machine
  limits, budgets) still refuse. Needs a portal deploy; a machine's worker takes the loosened `read_work`, `portal_logs`
  and `list_ffbox_files` schemas with its next update.
