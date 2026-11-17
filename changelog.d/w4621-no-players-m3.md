- **No timed leg or pair-run leg goes to a computer that runs no game players** (w4621, lothsahn; Ben's w3740 hold: "m3
  crashed again. you really need to stop crashin git"). `Machine.noPlayers` (add_machine `no_players "<why>"`, `""` clears
  it) defaults to m3 in code (`server/machines.ts` `NO_PLAYERS`), so no live setting is needed. timed_place, the timing order
  (w2055) and pinned timed starts treat it as taking no timed runs; a timed leg filed for it (w4584 was filed for m3, built
  on LothDesktop, then sent back to m3) moves to the next small computer that takes timed runs, or times on the big
  computer it is on when none can (w2048). Pair placement, the room counts and the WRONG STATE flag give it no pair leg.
  Its Unity editor, play mode included, still takes work, and its bench queue is unchanged. Docs: machines.md ("A computer
  that runs no game players"). Tests: `w4621NoPlayers.test.ts`.
