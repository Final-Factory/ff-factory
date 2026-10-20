- Work that needs a Live view goes to BEAST first (w1600, Ben: "can you prioritize beast for stuff that needs live view?
  live view is often too slow"). A request needs one once its worker starts a view or its words ask for one; the
  Capacity block says "Next Live view work: beast (…)", `config placement.live` changes the order, and other game work
  keeps `placement.prefer`. `stop_agent move_to` moves a worker between turns to another computer (its request goes on
  in a new session there from its pushed branch, with the view's settings in its handover). A Live view editor waits
  while a machine's bench lock is held by a timed run (the daemon reports it). docs/machines.md, "Placing work".
