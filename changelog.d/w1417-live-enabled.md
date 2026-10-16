- **An owner's orchestrator can switch the live view on** (w1417; Ben: "deploy, turn on live.enabled, and try it on the
  radiator glow").
  - `set_app_config` takes `live.enabled` (`true` / `false` / `null`). It is an owner's only, applies at once and is
    written to config.json.
  - Switching it off stops every running view, and every page gets its state again either way.
  - Docs: live-view.md. Tests: `appConfig.test.ts`, `live.test.ts`.
