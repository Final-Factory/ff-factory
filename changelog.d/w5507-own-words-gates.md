- **Relayed text in a person's turn no longer passes their gates** (w5507, lothsahn: "File it: high-risk gates check my
  own words, relayed text marked"). Some messages join a turn a person opened but are not theirs: the rest of an FFBox
  hand-over, a worker's report, a `[dispatch]` notice, another person's message. These are now marked in an
  orchestrator with FF Factory's "relayed into a turn your person started" line (`RELAYED_MARK`), and they set
  `SessionHandle.turnRelayed`. In such a turn, the gates reserved for the person's own words pass only with those words
  quoted in `words` from the person's own message in the turn, or with the person's click on a card. These gates are
  ops_worker send/deploy/restart, set_app_config, set_ffbox_config, set_pool, approve_delegation, delete/restore_memory,
  request_work/update_work's `humanAsked`, approve/decline, close/reopen and main_clone, and an owner acting on another
  owner's request. A turn only the person wrote passes as before. Refusals in request_work and update_work are still
  held for the next message (w830). Docs: orchestrators.md ("Whose turn it is").
