- **`ff-leftovers` sizes rows by what a delete frees, `remove` takes player slots, and empty slots leave the list** (w5168).
  In w5165 (LothDesktop) `folders` listed 12 player slots as DELETE at 1.3 GB each (15.7 GB), `remove` refused every one
  (only `remove-slot` took them), emptying them freed almost nothing (their files were hard links to a build still kept),
  and the 12 emptied slots stayed DELETE rows at 0 MB. Now a file with more than one hard link counts only when every link
  is deleted (`freeableBytes`, `server/cleanup.ts`): a row reads `0 MB, +1.3 GB hard-linked to files kept elsewhere, not
  freed`, the header totals what deleting every DELETE row together frees, and `remove`/`remove-slot` print and log the
  freed bytes. `ff-leftovers remove <slot>` empties a DELETE slot and keeps its folder, as `remove-slot` does, so one command
  takes every DELETE row. A slot holding only `leases/` is not listed (the header counts it) and `check` calls it KEEP.
  Docs: self-recovery.md, the worker's cleanup rules. Tests: `cleanupFolders.test.ts`.
