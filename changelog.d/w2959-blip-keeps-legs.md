- **A daemon's update no longer takes a request's workers off it** (w2959). After PR #810's rollout, the w2566 sweep read
  each ten-second daemon drop as an offline computer and took every stopped worker there off w2895, including legs the
  dispatcher had started a minute earlier; they ran on refused as "you are not on w2895". An offline computer now counts as
  away only past the blip grace (5 min). Docs: orchestrators.md, under the w2566 rule. Test: "w2959: a daemon drop of
  seconds" in `ledgerSweep.test.ts`.
