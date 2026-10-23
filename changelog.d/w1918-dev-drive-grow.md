- **The Dev Drive grows to a new size by itself** (w1918). `machine_update` with `dev_drive_max_gb` larger than the drive's
  maximum writes it into `devdrive.json`, and the machine's daemon grows the drive in place through a new SYSTEM task,
  `ffsb-helper-grow`, once no agent or editor is in a sandbox: the VHDX is detached, expanded, attached again at its letter and
  its ReFS volume extended, with new work held meanwhile. A smaller size is refused (ReFS cannot shrink). A drive installed
  before this gets the task from one administrator prompt on the PC, at the first such update. Tests: `devdrive.test.ts`,
  `machineGuard.test.ts`, and a real 64 to 72 GB grow in `devdrive-e2e.ts`.
