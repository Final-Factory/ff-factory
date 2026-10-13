- **The coordinators' routine turns run on Sonnet** (w1158, lothsahn: "2) Do it, use sonnet"). A turn no person's own
  message started (a worker's report, a relay, a timer, a check-in, a machine notice) runs on `claude-sonnet-5-5`; a
  person's message runs on Opus, mid-turn too, and so do the dispatcher's `[work request]`, `[work update]` and
  `[ledger]` decisions and a person's `[reaction]`. A routine turn within 60 minutes of an Opus turn stays on Opus,
  because a switch rewrites the conversation into the other model's cache. One session switches per turn with the SDK's
  `setModel`. Workers are not touched. Off switch: `set_app_config orchestrator.routineModel "off"`. Docs:
  orchestrators.md, "Which model answers a turn". Tests: `turnModel.test.ts`.
