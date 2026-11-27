- **Three more of the daemon's long event-loop blocks are gone** (w6486, after w6480 read an hour of BEAST's daemon log).
  The lab fixtures' folder look (`offeredDir`, 55.8 s in one realpath on BEAST) runs off the loop; the hello waits for the
  first look as before and says the last answer at once after that. The agent hosts' poll saves its `daemon.offset` with an
  async write, one at a time (6-10 s blocks); a daemon going away still saves it synchronously, and also in
  `daemon.offset.stop` when a slow poll write could land after it, so the next daemon forwards nothing twice. The leftover
  plan drops the items inside other items without comparing every pair, and `norm` keeps its answers for absolute paths
  (13 s of one block). Behaviour is unchanged; the fence probe's block is w6479's (#1497). Tests: `cleanupNested.test.ts`,
  `labFixtures.test.ts`, `hostWatch.test.ts`.
