- **A shared bench ticket waits for one exclusive turn at most, under every branch's copy of the queue** (w1962,
  lothsahn: "a shared bench-queue ticket (an editor start, a build) must not wait for hours behind one exclusive timed
  ticket after another"). The game repo's rule (FinalFactory #2368) only holds where the waiting tickets' own branches
  have merged it, and on LothDesktop none had. The daemon now raises the session of a waiting shared ticket that an
  exclusive turn has passed to `urgent` in `bench.queue/priorities.json`, which every copy reads at every decision: it
  sorts before the timed legs taken after it, and ends the holder's 30-minute turn where the priority hold (w1860) kept
  the lock. Editor starts' tickets get a session of their own (`editor:<sandbox>`) at their sandbox's worker's priority.
  `machine/benchRaise.ts`; tests in `server/benchRaise.test.ts`, one against the real script (red on a pre-w1962 copy
  without the raise, green with it).
