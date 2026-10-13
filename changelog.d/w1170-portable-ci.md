- **CI runs unchanged on FFBox, GitHub's runners or another machine** (w1170): the steps that differed between runners (the FFBox
  host's mirror before checkout, Node and gitleaks from the FFBox image, its Playwright browsers, the host artifact hand-off) are
  now [Final-Factory/ci-actions](https://github.com/Final-Factory/ci-actions) (`checkout`, `setup`, `playwright`, `upload`),
  at `@v1`, and every job's `runs-on` reads a repository variable: `FF_LINUX_RUNNER` (checks, secrets, identity,
  vm-scripts' plan; default `ffgithubrunners`), `FF_E2E_RUNNER` (Playwright, whose screenshot baselines match one machine),
  `FF_WINDOWS_RUNNER` and `FF_MACOS_RUNNER`. `.github/actions/ffghr-artifact-handoff` moved into ci-actions. The FFBox host keeps
  every ci-actions commit in its action cache (ffbox w1170). docs/ci-placement.md has the cost and security of each choice.
