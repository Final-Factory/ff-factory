- **A pair run waits for no named computer or hour while others have room, and stops on a compile error** (w4925, for
  lothsahn). w4622 waited 34 hours "blocked on lothlaptop coming back online" while biscuit and m5 had room: the
  dispatcher had pinned it to Windows. Now `decide_work block` with a `machine` or `time` gate on a pair run that has not
  started is refused while computers it can run on have room (the queue's own room test). A person's words in
  `override_gate` still let it wait, and are kept on the run (`pair.waitAsked`). The blocker watch also flags such a block
  that stands beside room (`[ledger] WRONG STATE: a pair run waits on ...`), once an hour.
  A pair run filed with `commit` is checked against that commit's CI every 2 minutes: once a run there fails with `error CS`
  lines, the pair run closes as done with `FAIL: did not compile ...` and the lines, its legs are told to stop, and its asker
  is cleared with them. w4880's CI was red on CS0103 at 07:31Z, five minutes after request_pair; its leg hit the same error
  in its player build at 07:48Z. Tests: `orchestrators.test.ts` (w4925).
  A repeat pair run for the same request records the sandboxes its last run used (`pair.warm`). The run's brief and the
  dispatcher's capacity ping name them ("start there when FREE ... never wait"), and `pairRoom` ranks their computers next
  after a cached or published player. On lothdesktop, a sandbox's next player build by the same worker took 490 s median
  (n=34), against 793 to 809 s otherwise (n=46; measured from player-cache/cache.log, 80 builds, 11-17 to 11-20).
