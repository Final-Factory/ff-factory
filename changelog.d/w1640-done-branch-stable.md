- **A finished dev request is no longer sent to FFBox again when its worker's sandbox moves on** (w1640; `show
  dev_requests` showed "done, no merge w1270" at 22:59, 23:00, 23:33 and 23:35 on 2026-10-20). A done update names the
  branch its newest worker's sandbox is on now (`boardFacts`), so each move of that sandbox to other work made the facts
  look new. A done update's branch no longer counts as a change once one was sent; records kept before this compare the
  same way, so the deploy sends nothing again. Test: `devRequests.test.ts` (w1640, "moves on").
