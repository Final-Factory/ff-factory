- **Smaller tool output for the coordinators** (w1159, lothsahn: "3) Do it"): tool results were 18-22% of what the
  dispatcher and the orchestrators spend, and each stays in the context. `ffbox_activity show config` lists by default only
  the effective values that differ from FFBox's file, with the sections and a count of the rest (`key` takes dotted
  paths, `full: true` is the old whole answer); its `logs` page is 100 lines, `conversation` 3 turns and `reports` 20
  unless `limit` asks for more. `spend_report session` lists the top 20 requests by cost and counts the rest
  (`requests: N` for more). `list_work id` prints the last 15 log entries and a count of the earlier ones (`full_log`
  for all) and the full cost block only with `spend: true`. `list_sandboxes` cuts long status and editor details and
  leaves out the last commit's subject and the PR link (`detail: true` keeps them); `list_machines` leaves out folders
  and the last clean-up (`detail: true`); `agent_transcript` shows 40 events with shorter cuts (`full_text`). The
  Capacity block, FREE marks and live agents are unchanged. Docs: ffbox.md, spend.md, machines.md, orchestrators.md.
  Tests: `toolOutput.test.ts`, `spend.test.ts`, `orchestrators.test.ts`, `agentState.test.ts`.
