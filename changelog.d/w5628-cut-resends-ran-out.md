- **The rollout report says when a machine's cut-download resends ran out** (w5628, from the w5622 review of w5593). After
  an update or agent tools run whose bundle download was cut has been sent again 3 times and cut each time, its line now
  ends "its 3 resends were cut too: its link to the portal stays slow, so it waits for the next deploy (needs a look)",
  instead of just no longer saying "sent again".
