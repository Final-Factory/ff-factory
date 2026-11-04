- **An exclusive timing turn pauses the machine's idle CI runners** (w3112, for ben: on m3 GitHub Actions jobs ran beside
  exclusive ticket t00001116, load average up to 24.1). While a timed run holds the lock, the daemon SIGSTOPs each idle
  `Runner.Listener` (a running `Runner.Worker` is a job: that listener is left alone and paused once its job ends) and
  SIGCONTs them when the turn ends, also after a restart (`<root>/tmp/bench.queue/runners.json`). Processes left in a
  runner's `_work` folder that no worker started get SIGTERM. Windows runners are not paused (no SIGSTOP); the game repo's
  `bench_queue.py` waits out their jobs. Docs: unity-lifecycle.md "The exclusive turn". Tests: `benchRunners.test.ts`.
