- **A machine hold can let named requests through** (w1863, lothsahn: "stop all work on LothDesktop except w1785 until
  it's done"). `placement.hold` takes `{ "why": "…", "except": ["w1785"] }` per computer. Workers holding an open request
  it names still resume there (check-ins, dispatches, messages); every other worker waits Blocked on the machine as
  before (w1376), and a plain-string hold lets nobody through. The exceptions are stored beside the reasons
  (`placement.holdExcept`), shown in the hold's reason ("…; except w1785"), and ignored for a paused machine or a coming
  build. Docs: machines.md ("Placing work", "A hold can let named requests through"). Tests: the w1863 cases in
  `resumeRules.test.ts` and `appConfig.test.ts`.
