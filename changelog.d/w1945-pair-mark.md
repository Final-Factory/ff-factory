- **A two-machine run filed by hand is marked a pair as it is queued** (w1945 follow-up): `decide_work queue` takes
  `pair_legs`, so a request filed with `file_work` (w1936, Ben's sync run for PR #2340) gets `WorkItem.pair` and its room,
  WRONG flag, capacity ping and hold read all its legs instead of flagging it for each single free computer.
