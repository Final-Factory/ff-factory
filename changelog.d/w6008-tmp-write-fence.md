- **Workers are told when their shell writes into /tmp** (w6008, lothsahn: "under no circumstances should workers write outside
  of ffw"). A redirect, tee, cp or mv target, delete, `mktemp` folder or tool output path under /tmp, /var/tmp, /private/tmp,
  /var/folders, AppData\Local\Temp or C:\Windows\Temp outside ffw gets a note pointing the worker at its own `$TMPDIR`, and a
  `tmp write fence (w6008, warn)` line in the daemon log. Warn-only: nothing is refused yet; the refusal comes in a separate,
  reviewed change. Docs: worker-fence.md. Tests: `tmpWriteFence.test.ts`.
