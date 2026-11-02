- **docs/ffbox.md says which FFBox turns may hand work to FF Factory** (w2887; lothsahn: "Ffbox should never hand off
  untrusted requests like ffagent. For ffdev it can"): a player's (ffagent) turn never does (ffbox #46 enforces it), an
  operator's ffdev turn goes as a dev request while FF Factory is connected and otherwise does the work on FFBox, and
  crash, desync and hang diagnoses (ffdiagnose) keep `intake.fff_handoff` and `fff.escalate.intake`. Docs only.
