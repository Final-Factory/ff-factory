- **The shared lock never hands icacls a name ending in a dot or a space** (w6437, from review w6380 of #1442). Windows drops
  a trailing dot or space, so a folder `evil.` beside a junction `evil` passed every link check and icacls labelled the
  junction's target. labelLow, labelTree and the transcript lock now skip any such name with a WARNING (never a failure, so
  the off switch is unchanged) and never use `<dir>\*` in a folder holding one. Linux: `/tmp/.dotnet` is now granted with the
  new `ff-landlock.py --rw-nofollow`, so a symlink planted there grants no write where it leads. macOS: no equivalent found.
  Docs: worker-root.md. Tests: sharedLock, transcriptLabels, writeLock.
