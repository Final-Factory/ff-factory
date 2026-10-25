- **A request with several workers keeps each worker's own wait** (w2153): one worker's `blocked_on` used to replace every
  gate on its request (`workerBlocked`), so a pair run's other leg lost its wait on its own PR's CI, and with it the report it
  left with merge on green. With no gate of its own left, the release pass stopped it as "its request is with another worker
  now" and released its sandbox, and the request showed Stalled (w2146 on 2026-10-25: host leg a4d94148 lost #2524's gate at
  14:22Z and was stopped at 14:23Z; w2137: 6ebd3483's gates on #2511 and #2516 went the same way). Now:
  - a worker's `blocked_on` replaces only its own gates and the dispatcher's, never another live worker's on the same request;
  - when one worker's gates have all cleared while another's still hold the request, that worker is resumed at once ("your
    wait on wNNN is over", with the `ff-pr merge` hint), and a gate it left with merge on green is merged and its report filed
    (DONE for its part); the request stays Blocked on the rest, never Stalled;
  - gates several workers set that clear in one look resume each of those workers, not only the first;
  - a pair run's leg started, or a worker moved to another sandbox (w2046), keeps the other worker's gates instead of dropping
    them, and is not refused by them.
  Needs a portal deploy.
