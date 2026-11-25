- **steam_upload no longer says the build account back when the portal's `steamBuildAccount` is unset** (w5640): the daemon
  redacted only the account the job carried, so BEAST's first live `check` printed ffsteam's "<account> logs in" with the
  account config.json names. It now redacts that one too. Test: `machine/steamUpload.test.ts`, "steam check: the account
  config.json names is not said back when the portal sends none".
