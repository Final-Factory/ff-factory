- **Requests blocked on a Claude pool hold resume by themselves when the pool has tokens again** (w1126, w1128, w1129,
  lothsahn: "Make the portal harness do this automatically"). A usage gate's ref is matched by the vault token's label, its
  bare name ("vault-lothsahn-1", what the dispatcher gave on 2026-10-12 and what never cleared), its person or "<person>'s
  pool", and refused when nothing answers to it; it clears when the pool can serve a worker or at the hold's end, whichever
  comes first, looked at on every usage reading, and resumes the request's worker. A message to a worker whose pool is held
  (a resume, a wake-up, `message_agent`) waits in the send queue for the pool instead of being refused, so the sweep no
  longer reports "the message never reached it". A standing agent's run waits for its pool instead of failing. A gate's
  resume still waiting when its request is blocked again on something else is kept for that gate, not delivered (w1128).
  Needs a portal deploy. Docs: orchestrators.md ("A Claude pool hold ends by itself"). Tests: `usageGate.test.ts`,
  `orchestrators.test.ts` (w1126, w1128, w1129), `standing.test.ts` (w1126).
