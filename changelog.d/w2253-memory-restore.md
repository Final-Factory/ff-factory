- **Orchestrators can restore a memory file of their own** (w2253: Ben's orchestrator wrote "PLACEHOLDER" over its
  `person-ben/corrections-log.md`, and nothing could put it back). The new `restore_memory` tool (group `core`, deferred;
  every person's orchestrator and the dispatcher) lists one file's copies (the three crash backups and, when the memory is
  a git repository, its last 10 commits, each with time, size and line count) and puts back the newest that differs from
  the current file, or the one named. Only its own folder, no `..`, links or wildcards, only in a turn its person started;
  the replaced file goes to the trash for 30 days and the restore is logged. The memory Write guard now refuses a Write over
  an existing memory file the process has not Read. This deploy also put Ben's file back once at start, from the newest
  copy that is not "PLACEHOLDER" (docs/orchestrators.md, "Restoring a memory").
