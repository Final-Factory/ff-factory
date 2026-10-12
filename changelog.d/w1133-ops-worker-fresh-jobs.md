- **Every new job for the ops worker starts a fresh conversation, for every orchestrator** (w1133, lothsahn: "Every time you
  call the ops worker with a new request, you should clear its context or use a new session. Same thing with Ben's
  operator"). `ops_worker send` used to continue the last conversation for up to 12 hours unless the caller passed
  `fresh: true`. Now every `send` in a turn the person started is a new job (a new conversation and process, on that
  person's token), and the new `follow_up: true` carries on the same job (the caller's own open job only; refused
  otherwise). The orchestrator's check-ins, timers and `[ops worker]` reports still follow up an open job with no flag.
  A new job (`send`, `deploy`, `restart`, `machine_update`) is refused while the worker is mid-turn on the open job instead
  of cutting that turn off, which `machine_update` used to do to the machine before it; `fresh: true` on `send` stays the
  explicit cut-off. The orchestrator prompt and the tool description say it, and docs/ops-worker.md, "A new job, a
  follow-up", has the rule and why. Needs a portal deploy (lothsahn decides when). Tests: `opsWorker.test.ts`, "w1133".
