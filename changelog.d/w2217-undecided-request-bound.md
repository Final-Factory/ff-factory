- **A request left undecided is offered to the dispatcher again, then shows Stalled** (w2217, lothsahn: "no request sits as
  "new: Working (the dispatcher has it to decide)" without a decision for more than a few minutes"). w2192, a pair run
  request_pair filed at 20:56Z on 2026-10-25, got its one `[work request]` at filing and sat 3 h as Working: nothing sent it
  again, since the capacity pings name only Queued requests. Now the blocker watch offers a request still `new` 15 minutes on
  to the dispatcher once more (its log says so), and still undecided 5 minutes after that its live state is Stalled
  ("undecided for N min") instead of Working. A notice that cannot reach the dispatcher is now said in the journal instead of
  dropped in silence. Docs: orchestrators.md (the live-state table). Tests: `orchestrators.test.ts` (w2217).
