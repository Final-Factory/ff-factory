- **A run reads only its own GitHub App tokens** (w5547). The daemon writes each run a file of its own,
  `gh-app/sessions/<session>.json`, with only the apps the portal named in its spec, and rewrites it with each new token;
  the run's git helper, gh shim and ff-pr read that file (`FF_GH_APP_SESSION_FILE`), and `FF_GH_APP_FILE` is gone from
  worker environments. `gh-app/tokens.json` is closed to workers (w5546). A worker that sets `FF_GH_APP_NAMES` to another
  app's name gets no token for it. Docs: github-apps.md. Tests: githubApps.test.ts ("w5547").
