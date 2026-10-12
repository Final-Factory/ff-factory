- **A released worker on non-game work resumes on an agent seat, and a message waiting for its machine goes when the
  daemon is back** (w1135, lothsahn: "Shouldn't be queued now"). A worker whose open requests all need only an agent slot
  (w1098) resumes at once in its own sandbox or the one with the most seats free, beside the agent there, with nothing
  switched or stopped, instead of waiting for a free game sandbox. The send queue is delivered right after a daemon's
  hello, and a queued message shows what holds it now, not the "offline" it was queued with. Needs a portal deploy.
  Docs: machines.md ("Work that is not the game's resumes on an agent seat"). Tests: `placeAgain.test.ts`,
  `agentSession.test.ts`, `machines.test.ts` (w1135).
