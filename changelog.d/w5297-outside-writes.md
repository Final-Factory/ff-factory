- **Workers' caches and Unity logs stay in the install folder** (w5297, lothsahn: "under no circumstances should workers
  write outside of ffw"). The daemon's environment now points pip, npm, NuGet, dotnet, Playwright, Unity's Package Manager
  and Asset Store caches, and on macOS and Linux every XDG cache, into `<root>/cache`, and turns off gh's update check.
  A `unity-slot run` of Unity in batch mode with no `-logFile` logs to the worker's temp folder instead of the person's
  Editor.log, and a sandbox editor on Windows keeps its temp files in `<root>/tmp/unity`. Applies at each daemon's next
  update (editors at their next start). `server/outsideWrites.test.ts` fails on a new folder outside the root or a new use
  of the home folder, AppData or the system temp in the daemon's code. Inventory, per OS, of what still writes outside and
  why: docs/worker-root.md 2.7.
