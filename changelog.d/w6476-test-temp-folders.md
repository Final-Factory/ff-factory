- **A full test run leaves nothing in the temp folder** (w6476). Before this change, one Windows run on BEAST left 547 folders and files in
  `os.tmpdir()`, and a worker's temp folder held 12,899 after a dozen runs. Tests now make their folders with
  `server/testTmp.ts` `tmpDir(prefix, t?)`. The folder is removed after the test, or when the file's process exits if the
  helper has no test context, and the file fails, naming the folder, if something still holds it. Several tests had open
  handles that stopped the removal, and those are now closed first: sqlite test-history databases left open, a provider
  manager's late save that wrote its folder again after it was removed, and a session's transcript seal written after the
  test ended. One hang came from the order of `server/crashRecovery.test.ts`'s teardown hooks. Its temp-folder removal ran
  before the server's kill, failed with EBUSY, and so the kill never ran: the server child kept running for 30 minutes and
  held up the whole suite. The kill now runs first and waits for the child to exit. Tests start no daemon keep-awake
  holder (`FF_KEEP_AWAKE=off`; a holder killed mid-`Add-Type` left csc's files behind), and npm's compile cache is off
  (`NODE_DISABLE_COMPILE_CACHE`). The code that runs outside tests had two small leaks, both fixed: the Evidence check's
  fetched HUD pins folder was never removed, and `scripts/test-watchdog.ts` left its `ff-inflight-` folder after each run.
