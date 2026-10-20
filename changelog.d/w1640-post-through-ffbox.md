- **FFBox posts by itself only for players and merged fixes; FF Factory's agents post the rest through it** (w1640;
  lothsahn: "I think FFBox should handle all messaging in two cases: 1). The user is a player and it's going to the
  ffagent sandbox. 2) it's a pr that's been merged. ... In all other cases, you or workers should be able to post direct
  to discord by asking ffbox to do it on your behalf through the tunnel, and it will post what you say."). `post_as_max`
  takes channel `conversation` (a conversation FFBox holds, named by FFBox's id or its Discord thread, #bug-reports and
  dev_bug_reports threads included) and is an orchestrator's tool too. `reply_to_ffbox` in a report thread posts in the
  thread, not by Max DM. The orchestrator and worker rules say to answer with `reply_to_ffbox` before closing (FFBox
  says no "Queued as", "PR is up" or "Done" any more) and how to ask a reporter for a save. Docs: ffbox.md ("Discord",
  "Posting as Max", "Dev requests"), max.md, orchestrators.md, worker-base.md, ffbox-connector-contract.md. Tests:
  `ffboxPost.test.ts`, `toolManifest.test.ts`.
