- **A settled question no longer leaves a request "Waiting on input"** (w3615, lothsahn: "If it's already answered and not
  waiting on Ben or me, shouldn't it be queued and not in a blocked state?"). When the dispatcher decides a request whose
  question is still pending (block, queue, merge, link, reject, done, or a new worker started on it), an operator answers it
  on FFBox, or another requester answers it, the question closes, its `[needs you]` is answered, the asked people's cards
  about it leave their Waiting tab, and their orchestrators are told. The live state then follows what the request waits on
  now: w3533 showed Waiting on input on Ben after the dispatcher blocked it on w3612. At the first boot after this lands, requests already left that way (w3533 among them) are settled the same way.
  Docs: orchestrators.md. Tests:
  `orchestrators.test.ts` (w3615).
