- **Two release lanes** (w1639, lothsahn: "Then Ben and I can ask for a release (ffbox) or a quick or urgent release
  (beast, if offline, LothDesktop)"). "A release" is FFBox's: no FF Factory computer builds it, it takes no `build_plan`,
  and its worker waits on FFBox with a 40-minute check-in instead of a sandbox (`needsBuild` no longer matches "release
  build" or "ci-release"). "A quick release" or "an urgent release" is the urgent lane: priority urgent, placed by "Next
  urgent release work" on BEAST, else LothDesktop when BEAST is offline (`DEFAULT_BUILD` `['beast', 'lothdesktop']`, the
  first online one), never passed over for a timed leg (its exclusive bench tickets go first after the leg running now;
  w1628's diversion is gone), built and uploaded with the game repo's `scripts/release/urgent_release.py` while FFBox
  declines the claimed bump. `build_plan` refuses an offline build computer and names the next online one. A Live view on
  a computer being cleared stays open: its worker is told to start no compile, test or build until the build is done, and
  told when it is. `read_rules release` (`server/releaseLanes.ts`), the worker and dispatcher prompts and
  docs/orchestrators.md route both. Tests: `w1639ReleaseLanes.test.ts`, `w1628Placement.test.ts`, `placement.test.ts`,
  `buildPlans.test.ts`.
