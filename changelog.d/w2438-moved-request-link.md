- **A request moved to another computer is linked to its new session even while it is Blocked** (w2438). The w2046 move (a full
  computer, or a timed leg's preempt, w2055) started the new session and then refused its ledger link when the request was gated
  on another request, because the gate's setter had just been taken off it: w2434's session 172ab5ee ran on m3 unlinked while the
  request showed Queued. Now the moved worker's gates pass to the new one and the request stays Blocked on them; a link that still
  fails stops the session it started.
