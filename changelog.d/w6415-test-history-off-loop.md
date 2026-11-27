- **Test history no longer holds the portal's event loop** (w6415): recording a test run (a full suite is about 22,000
  cases) took 1 to 13 s on the loop on 2026-11-27. Now one writer thread records each run on its own connection, with the
  same code and in one transaction as before (`server/testHistoryWriter.ts`). CI's NUnit files are parsed there too, and
  so is the prune. A local run is acknowledged to its daemon only once it is committed. The ready-made queries and the
  labeller's reads run on a read-only worker thread, and the labeller lets the loop run every 40 ms. Measured on a 64 MB
  test database: a 22,000-case run took 16.7 s on the loop the old way; the loop is now held at most 29 ms. Needs a
  portal deploy.
