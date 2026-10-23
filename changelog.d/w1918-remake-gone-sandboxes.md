- **A sandbox whose folder went with a reset Dev Drive is made again** (w1918: LothLaptop's V: was reset; the update cloned
  the repo again but slot1 stayed "ready" with git "unknown", so no worker could start there). The daemon's pool remakes each
  free sandbox whose folder is gone, once the sandbox root and the main clone are there, on its branch (the clone's, else
  origin's, else its base, else the default branch), once per sandbox per daemon run; it shows "creating" meanwhile and logs
  why. A drive that is not attached has no sandbox root, so nothing is remade then. Docs: worker-install.md ("The whole root
  on the Dev Drive"). Tests: `machineSandboxes.test.ts`.
