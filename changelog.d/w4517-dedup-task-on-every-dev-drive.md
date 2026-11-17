- **Every Dev Drive install and update registers the weekly full ReFS dedup task** (w4517, lothsahn: "Has this change been
  applied to the installed and all Windows boxes like beast?"). `devdrive.ps1` registers `ffsb-helper-dedup` with the other
  helper tasks, so the installer and an elevated update install it and the current helper; a non-elevated update of an older
  drive asks for the one administrator prompt on the PC's desktop, as for the grow task (`ensureHelperTask`). On a volume
  without ReFS dedup turned on, or a Windows without its cmdlets, the task runs nothing and says why. Tests: `devdrive.test.ts`
  (dedup), `devdrive-e2e.ts` (the tasks registered).
