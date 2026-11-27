- **Windows stops writing the old `<root>\tools\shims`** (w6101, enforce after #1391): it is written only while an agent
  host started before the move has it on its PATH, and removed (checked each minute) once none has. `shims` leaves
  `MEDIUM_TOOLS`; the old folder stays Medium while it exists. A file in `<root>\tools-medium\shims` the daemon does not
  write is moved to `<root>\tools-medium\quarantine\shims-<time>-<pid>` with a WARNING, at start and after the fence
  labels (nothing deleted). Applies at the daemon's next start. Docs: worker-root.md. Tests: `w6101WinShims.test.ts`.
