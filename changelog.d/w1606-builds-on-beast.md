- Builds run on BEAST first, and a build declared coming clears it (w1606, Ben: "when you know builds are coming up, we
  also prioritize using beast for builds because its faster"). A worker (or the dispatcher, for a request) says
  `build_plan coming` with the minutes until it starts: no new work goes to BEAST from then, and when it is due the workers
  there between turns move to other computers, the ones that cannot move are paused, and the ones mid-turn finish their
  step and pause; a running Live view is left alone. `build_plan start` waits for BEAST's bench lock and for those turns
  (at most 20 minutes); `done` resumes the paused work. The Capacity block says "Next build work: beast"; `config
  placement.build` changes the order.
