- **ff-factory's CI runs on GitHub's hosted runners again** (w1194, lothsahn): `ci.yml`'s checks, Playwright, secret scan and
  identity check, vm-scripts' plan and `rerun-lost-runner.yml` leave FFBox's `ffgithubrunners`, which now serve the game
  repository only. The jobs use the standard actions again (checkout, setup-node with the npm cache, upload-artifact, pinned
  by commit; gitleaks checksum-checked from its release in `.github/actions/gitleaks`) instead of Final-Factory/ci-actions,
  the `FF_*_RUNNER` variables are gone, and `rerun-lost-runner.yml` calls the API itself again. Free for this public
  repository; docs/ci-placement.md has the cost, the fork pull request rules and the screenshot baselines.
