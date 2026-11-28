- A request whose worker's own check-in came due with nothing to deliver it now resumes by itself (w6768): a worker on a
  computer away past the grace is moved off it as a stopped worker's work is (w2544), with the check-in's note as its
  message, and a worker that is gone (removed with a deleted sandbox) is replaced by a fresh worker where the work fits,
  its prompt leading with the note. It reads Stalled with the reason until then. The new owner-only setting
  `lostCheckIns` ("on" by default, "warn" to only show and tell the dispatcher) is the recovery switch.
