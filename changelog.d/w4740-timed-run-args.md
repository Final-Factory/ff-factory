- **`timed_run` takes `=` switches and files of the build folder** (w4740, r290 fix 6; w4591 lost its first three calls to
  it): `-ffFeatures=station-multiselect` passes as `-ffFeatures station-multiselect` did, and a value may be a path from the
  build folder (`-ffDeckTour tour.json`, `tours/a.json`), where the player starts. An absolute path, a drive or a `..` step
  is still refused, now with the way: put the file in the build folder and pass its path from there. The run's own switches
  stay refused in the `=` form too. Docs: machines.md ("A switch's value"). Tests: `timedRuns.test.ts`.
