- **The path fence, w6103's notes** (w6144, macOS and Linux): the shims a retry writes after a failed start have their
  modes guarded too; a mailbox or root a worker chmodded 000 is put back before the old `bin` is mended; and on macOS a
  folder at 000 gets its owner bits back with `chmod -h`, which never follows a link swapped in. Docs:
  `docs/worker-fence.md`, "After w6103's review".
