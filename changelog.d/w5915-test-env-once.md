- **Clean-up keeps a Unity clone's linked Library on a worker's Windows computer** (w5915): a junction a Low-integrity
  process made looked like a plain folder to the stale-Library scan, so it planned to remove a clone's `Library` link;
  its size and "changed recently" walks also went through such a link into what it leads to. Both now read the folder
  entry, which knows it is a link.
- **`npm test` clears a worker's session settings once, in the test runner** (w5915): a program a test starts with the
  runner's own options kept losing the FF_ settings the test handed it (the real ff-leftovers CLI lost its cleanup facts).
- **Tests wait for a worker's hand-over or room move to finish, not for 5 s** (w5915): `Agents.settled()` resolves once
  every start and move it began without waiting has ended, and the test kit's hand-over and w2046's move wait for it. On a
  loaded BEAST their ~30 git processes outran the 5 s wait. providerLedger's test now stops Agents' timers before its
  folder goes, and w2867's test waits for the turn FF Factory's message opened to end before Ben answers.
