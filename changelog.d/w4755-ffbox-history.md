- **FFBox's conversation history, read from FF Factory** (w4755; FFBox's new `history` query, commit 73a3d49). The
  orchestrators' `ffbox_activity {show: "history", agent_class?, after?, before?, limit?, turns?, chars?, empty?}` shows one
  page of FFBox's whole conversation database, oldest first, as FFBox's JSON under an untrusted-data header, ending
  `more: after N` when more remain. The new worker tool `fetch_ffbox_history {agent_class? (default ffagent), after?,
  before?, max_conversations? (500, at most 5000), turns? (10), chars? (4000), empty?}` follows `nextAfter` page after page
  (at most 25 queries a minute, 8 minutes, an error answer ends it and keeps what came) into ONE JSONL file in the worker's
  `Inbox/`, a line a conversation, and says the id range and the `after` to continue with. Read-only: nothing is posted or
  written on FFBox. `history` is never served as a last known answer. The `ffbox_activity` rule line that said the tool "takes
  all nine" views now says seventeen. A deploy needs the portal and each machine's daemon on this version, and FFBox with
  `history`. Docs: ffbox.md ("History"), ffbox-connector-contract.md. Tests: `ffboxHistory.test.ts`.
