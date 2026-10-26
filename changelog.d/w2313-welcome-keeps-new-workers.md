- **A worker started while its machine's daemon was reconnecting is no longer stopped by the welcome** (w2313, lothsahn:
  "Workers stopped by a machine daemon redeploy are never resumed"). The portal's welcome to a daemon named the machine's
  sessions as they were when the link opened; on a machine with more than 200 sessions it goes out after the hello, and the
  daemon stops every agent it does not name. On 2026-10-26 that stopped worker a3d1d9f7 (w2302) mid-turn on beast, 40 s
  after its brief was delivered, with no link drop, so it was never noted as cut off and sat Stalled for 3 hours. The welcome
  now names every session the machine has when it is sent. An update over the link also names itself in the resume of the
  workers it cuts off ("was updated over its link"). Docs: machines.md ("Cut off mid-turn"). Test: `machines.test.ts`
  (w2313).
