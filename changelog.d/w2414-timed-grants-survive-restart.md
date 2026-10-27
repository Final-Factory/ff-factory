- **A timed run waiting on its computer survives a portal restart** (w2414, lothsahn: "Timed run tr_e93675645e's results
  were lost when w2369 moved workers"). tr_e93675645e waited in lothlaptop's queue; the 17:08Z portal update wiped the
  in-memory grants for its pieces, so when its turn came at 17:18Z they were refused and it failed without playing. Now
  every daemon hello and run status grants a waiting run's pieces again, a refused run is sent again once, and a second
  refusal says to redo it. A message moved with its request names its attachments for fetch_attachment. Docs:
  machines.md ("A queued run keeps the right to fetch its pieces"). Tests: `w2414TimedGrantRestart.test.ts`.
