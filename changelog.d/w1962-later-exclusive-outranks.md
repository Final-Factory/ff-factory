- **A shared bench ticket that a later timed leg outranks is raised too** (w1962). On LothDesktop at 04:04Z on
  2026-10-24, after the first raise was deployed, w1905's normal build still waited (since 01:03Z): w1789's high timed
  leg, taken after it, sorted ahead of it and itself waited behind a running shared group kept urgent by game players,
  so no exclusive held the lock and nothing marked the build. The daemon now also marks a waiting shared ticket that a
  waiting exclusive ticket taken after it outranks, and raises it: it joins the running shared group. The exclusive leg
  still never runs beside shared work. `machine/benchRaise.ts` `passedShared`; tests in `server/benchRaise.test.ts`,
  one against the real script (red without the change, green on a pre-w1860 copy, a pre-w1962 one and master).
