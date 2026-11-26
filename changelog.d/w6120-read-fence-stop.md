- **A read-fence switch stops a first `on` mid-run** (w6120): an `off` or `warn` sent during a first read-fence `on` on Windows no longer waits for the whole label run (about
  11 minutes on LothDesktop): the `on` pass now stops between its label Sets, skips the WRITE_OWNER grant and retry for
  closed paths, and stops its walk inside the closed folders once the mode changes. The login watcher's tick now waits
  its turn behind label passes.
