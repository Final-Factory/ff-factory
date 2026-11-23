- **Handed-up follow-ups are filed in one call** (w5222, lothsahn: "It took you a while to answer a single question from
  me"). A personal orchestrator's new `file_follow_ups` files a request's handed-up briefs as the worker wrote them,
  through `request_work`'s own limits, instead of the model retyping each one: on 2026-11-23 filing 21 that way took 125 s,
  122 s of it the model writing, and kept a person's question waiting 105 s. The `[follow-ups to file]` message names it
  and says to answer a waiting message from the person first. Docs: orchestrators.md (w2969 section), tool-manifest.md.
