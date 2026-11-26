- **A held leg keeps its place, and moves keep to a request's legs** (w5860): a computer's next free sandbox or agent slot is
  held for an older or higher request's leg (`decide_work queue` with needs, w1863) for up to 30 minutes, so `start_agent`,
  room moves and priority reclaims of later work of the same or lower priority wait (strict priority, then oldest first,
  w4620). A moved request (w2046, the agent-cap move) stays on the computers its legs name, and a seat-only move skips a held
  computer as a game move does. A machine hold still reaches placement only through config `placement.hold`.
