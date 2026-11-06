- **A longer bench turn a person approved** (w3186, for ben on w3159: "Give each overload run a one-off 60-minute
  exclusive turn on biscuit, with the ffu test runners paused"). A person's own orchestrator records it with the new
  `grant_bench_turn` tool, in that person's turn and with their verbatim words: N turns (1 to 4) of M minutes (31 to 240)
  on one machine for one request's worker. The portal marks that worker's sessions there `exempt: 'approved'` in
  priorities.json (only the daemon writes it); the game repo's `bench_queue.py` gives their exclusive tickets the M
  minutes, with the clock started once the machine's CI jobs drained (waited up to 60 minutes), and the daemon keeps the
  CI runners paused through it (w3112). The portal counts the turns from the machine's bench state and ends the grant once
  they were used and let go, on cancel, on the request's close, or after 7 days. The 30-minute turn stays the default.
  Docs: orchestrators.md "A longer bench turn a person approved", unity-lifecycle.md "Turn limits". Tests:
  `benchGrants.test.ts`, `orchestrators.test.ts` (w3186), `benchState.test.ts` (w3186).
