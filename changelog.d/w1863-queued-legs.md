- **A leg queued for a named computer is no longer lost** (w1863, lothsahn: "Why did they hang if the m5 was free?").
  `decide_work queue` with `needs` on an active request that has a worker now records a leg (`WorkItem.legs`) and leaves
  the request active. The next message to its worker used to set the request active again and drop the queue, so w1789's
  and w1785's m5 timing legs sat unseen while m5 was free. A leg outlives its worker's messages and reports and its PRs
  merging. It shows Queued, and `Queued [WRONG: m5 has room]` while its computer has room. The dispatcher gets the WRONG
  flag and the capacity ping for it, and "Next timed work" and the Capacity block name it. It goes when a worker starts
  for the request on that computer, with `drop_leg`, or when the request closes. Docs: machines.md ("Placing work"),
  orchestrators.md. Tests: the w1863 cases in `orchestrators.test.ts`.
