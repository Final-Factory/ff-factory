- **`unity-slot run` in a checkout without `scripts/bench/bench_queue.py` takes its ticket with another sandbox's copy**
  (w5026, lothsahn). It passed no worker root to `benchTicketFor`, so the w1628 search through `<root>/sandboxes/*` never
  ran and a pre-1.0 checkout exited 69 ("no shared bench ticket ... no scripts/bench/bench_queue.py in this checkout or in
  any sandbox here"). It now passes `FF_WORKER_ROOT`, and `benchTicketFor` defaults its root to `FF_WORKER_ROOT` as
  `benchLockPath` already did. Applies at each machine's next daemon update. Test: `benchBuilds.test.ts` (w5026).
