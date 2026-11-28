- **The instance updater says when an instance's start-portal.sh is out of date** (w6603). On each pass, `update-all.ts`
  checks every listed instance's `start-portal.sh` against the one `scripts/instance/new.ts` writes now and logs once,
  in `update-all.log`, what it lacks: the portal priority raise (w6221), or the winpid retry from ff-factory #1508 (w6542)
  in place of the one-shot raise that could raise a bash.exe instead of the portal. Warn only: the script is never changed.
  Docs: instances.md. Tests: `instance-update.test.ts`, `instance-new.test.ts`.
