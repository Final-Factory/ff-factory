- **ReFS dedup repairs itself after a remount** (w6597): a new helper task, `ffsb-helper-deduprepair`, runs nightly
  before the dedup job and right after a remount the watch from w6573 flags. When the dedup service stopped watching the
  Dev Drive, the task restarts that one service and confirms it watches the drive again, and the helper's result says
  "dedup repaired". It runs as LOCAL SERVICE with its own task SID, may only query, start and stop `refsdedupsvc`, and
  writes only its own results folder. docs/sandbox-disk.md has the details.
