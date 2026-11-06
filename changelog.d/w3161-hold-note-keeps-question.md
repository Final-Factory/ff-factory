- **A person's hold note outside their own turn no longer answers the dispatcher's question** (w3161). w3155 (Ben's Steam
  Deck check) was asked with decide_work ask (status `question`); Ben's orchestrator then wrote "Hold w3155 until Ben says
  he's ready" in the [needs you] turn, not a turn of Ben's, and update_work treated any note as the answer: it put the
  request back to `new` and dropped its question, so the w2217 bound offered it to the dispatcher again as undecided 15 min
  later, it asked Ben again, and the request showed Stalled. A note now answers the dispatcher's question only in the
  person's own turn; otherwise it is kept and the request stays Waiting on input on that person (server/orchestrators.ts,
  update). Escalation and design-question flags keep their old path. Needs a portal deploy.
