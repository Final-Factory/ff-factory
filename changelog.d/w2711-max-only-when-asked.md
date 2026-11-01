- **A worker posts as Max in a bug thread only when asked** (w2711; lothsahn, 2026-10-31: "Stop"): `post_as_max` in a
  #bug-reports, dev_bug_reports or feedback thread only when someone in that thread mentioned Max, or when a person
  asked for that post; never to ask a player a question on the worker's own initiative. A save or a repro step it needs
  goes in its report as a blocker, and the person's orchestrator decides. The worker prompt's Discord rules and the
  `post_as_max` description say so. Docs: max.md, ffbox.md ("Posting as Max", "Discord", "Dev requests"),
  worker-base.md. Test: `intakeFlow.test.ts`.
