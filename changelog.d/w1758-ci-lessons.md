- **What two weeks of CI flakes taught, written beside the code** (w1758): `docs/ci.md` names every Playwright and Windows
  failure of 2026-10-13..22 with its cause and fix, and how to instrument a flake only CI shows (a scroll log and repeated
  projects on a draft pull request); `CONTRIBUTING.md` gains five rules: tests that tap or measure a chat get a login of
  their own, element screenshots hide the notice bars, a CI step's limits survive a runner move, after-hooks end
  processes before removing folders, and a test's stand-in process waits for the test, not a timer.
