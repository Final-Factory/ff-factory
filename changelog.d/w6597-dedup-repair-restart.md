- The nightly ReFS dedup repair (w6597) always starts `refsdedupsvc` again once it has stopped it, whatever fails after the
  stop. The first forced test on LothDesktop left the service stopped: the stop deletes the volume task, and the next
  `schtasks /query` wrote "cannot find" to stderr, which Windows PowerShell 5.1 treats as a terminating error under `Stop`.
  Native commands now run through a helper that keeps stderr as text. The stop deletes the volume task, the nightly
  trigger, so "repaired" now needs it registered again by the service after the start, and a missing task is itself a
  reason to repair.
  `-DedupRepairMode force` is the documented forced test, and the Dev Drive e2e runs it as the task and proves the restart
  after a fault (`-FailAfterStop`).
