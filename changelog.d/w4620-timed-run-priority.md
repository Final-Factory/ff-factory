- **Timed runs on one computer go in strict priority order** (w4620, lothsahn: "Why is urgent work in a queue behind non
  urgent work? ... The factory should be using strict priority queues"). A computer's daemon plays one timed run at a time,
  first come; the portal now moves a run that never held an exclusive turn behind a higher-priority run that arrived after
  it (it steps back and is sent again at once). Priority is the run's open requests' highest, read live, so raising a
  request moves its waiting run up within a minute; a run whose turn is playing finishes. Each move is logged naming both
  runs. tr_903bab15aa (w4591, urgent) had waited on LothDesktop behind tr_97b11ed6a4 (w4587). Docs: machines.md ("Strict
  priority on a daemon"). Tests: `w4620TimedPriority.test.ts`.
