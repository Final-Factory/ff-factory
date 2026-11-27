- **A worker waiting on a follow-up it handed up is Blocked on it and resumed when it closes** (w6397, for lothsahn: w6096's
  worker handed up the flaky gateway_standby test, was never told it was filed as w6254, and w6096 sat Stalled 8 h after
  w6254 closed). A worker's still-open line that waits on its handed-up follow-up ("blocked on the follow-up I handed up",
  or one naming it handed up) records a request gate on the newest open follow-up filed for it, through w2422's
  reported-wait recording, so the request shows Blocked on it, not Stalled. A worker still mid-turn when the follow-up is
  filed is told its id, to call blocked_on itself. The follow-up done clears the gate and resumes the worker; cancelled or
  declined resumes the worker with that news, instead of asking its person. hand_up_requests and the worker prompt say how
  to wait. Tests: `w6397HandUpWait.test.ts`.
