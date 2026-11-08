- **The intake card reads FFBox's own plain Cause, Fix and Risk** (w3622, lothsahn: "Lead the card with a plain-language
  summary a reviewer can decide from in one read"). FFBox's diagnosis summary now opens with a plain `root cause:`, then
  `Fix:` and `**Risk:**` lines for the reviewer (ffbox 86a54df, `scripts/intake/diagnose.md`). The card's parser reads
  the Risk line alone, not the evidence after it. Test: `intakeDigest.test.ts` on a test turn in that form
  (`server/fixtures/ffboxReviewerSummary.ts`), which the Waiting on input fixture card now shows.
