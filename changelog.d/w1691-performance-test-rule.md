- **The orchestrators' and the dispatcher's briefs carry the game's Performance-test rule** (w1691, lothsahn: "Tell the
  agents they can still write performance tests but they should all be flagged performance if they check timings"). A
  game test that asserts on timing carries `[Category("Performance")]` and checks nothing functional, functional tests
  never carry it, Performance tests run in no CI, a worker fixes a wrong tag where it meets one, and no brief asks to
  loosen a timing threshold. One bullet beside each prompt's merge-on-green line (`server/agents.ts`); the full rule is
  the ff-agents evidence-gate lesson.
