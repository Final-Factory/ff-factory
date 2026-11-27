- **The shared lock never hands icacls a name ending in a dot or a space** (w6437, from review w6380 of #1442). Windows drops
  a trailing dot or space, so a folder `evil.` beside a junction `evil` passed every link check and icacls labelled the
  junction's target. labelLow, labelTree and the transcript lock now skip any such name with a WARNING (never a failure, so
  the off switch is unchanged) and never use `<dir>\*` in a folder holding one. Linux: `/tmp/.dotnet` is now granted with the
  new `ff-landlock.py --rw-nofollow`, so a symlink planted there grants no write where it leads. macOS: no equivalent found.
  Docs: worker-root.md. Tests: sharedLock, transcriptLabels, writeLock.
- **A device name such as NUL counts as a trick name too** (w6437, from review w6452 of #1479). icacls fails with exit 87
  on `<dir>\NUL` or on `<dir>\*` with a NUL in it, so one file a worker made failed every pass, the way back to off
  included; such names are now skipped with a WARNING like the rest. A moved-in seed entry or player holding one (or a
  name ending in a dot or a space) is removed again and said (lockIn), and removed by its `\?\` path when `rd /s /q`
  leaves it. The spawner, a pin taken back to Medium and the unlock now say each name they skip. Tests: sharedLock,
  transcriptLabels.
