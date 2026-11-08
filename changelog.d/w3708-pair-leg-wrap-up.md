- **A pair run no longer stays Blocked on a leg that never says DONE after the host's DONE** (w3708): the host leg's DONE
  drops the waits it set on the other legs and tells each of them the run is over; a leg that still goes on without DONE is
  reminded once, then the run closes on the host's report with that leg's state noted, or the dispatcher decides where the
  host's report cannot close it. w3523's client leg ended six times over 5 h after its host's DONE, each time "still has
  work on it: the request is blocked on worker" itself, until a person closed it.
