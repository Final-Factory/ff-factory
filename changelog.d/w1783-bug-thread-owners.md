- **Every bug thread has an owner** (w1783, Ben: "when I respond to a Discord thread and say, we'll fix, that means you're
  fixing it"; "any indication that I'm acknowledging it as a bug is sufficient"). A new `BugThreadWatch`
  (`server/bugThreads.ts`) reads #bug-reports and dev_bug_reports read-only with Max's token every 5 minutes. A reply from
  an owner (ben, lothsahn, by Discord author id) that a model (Haiku) judges acknowledges the bug, in any words, files
  their own request at once, approved by them, with the thread as its subject; a second reply files nothing, and a request
  already waiting for a reviewer is approved in their name. Every hour a coverage check files, for a reviewer, each thread
  of the last 7 days that no request, no game-repo PR's `Discord:` line and no FFBox PR owns; a sweep's window owns no
  thread it does not list. Nothing posts to Discord; FFBox is unchanged. On by default (`intake.bugThreads`). Docs:
  intake.md, "Every bug thread has an owner". Tests: `bugThreads.test.ts`; the real judge: `scripts/ownerAckEval.ts`.
