- **Unity slot requests and bench tickets go only through the daemon's own calls** (w5545, item 9 of lothsahn's w5451
  rogue-worker audit). The daemon serves calls on 127.0.0.1 (`<app_dir>/rpc.json`); each agent gets `FF_DAEMON_RPC` and
  `FF_DAEMON_TOKEN`, a signed token naming its session and sandbox, so a request's holder, session and priority come from
  the token, never from a file the worker wrote. The slot arbiter reads only `<app_dir>/slot-queue` (`<root>/unity-slots`
  stays the mailbox for jobs and shims; a request file dropped there is ignored), and the bench queue moved to
  `<root>/daemon/bench.lock` and `bench.queue`, where the daemon takes each worker's ticket itself (`machine/benchProxy.ts`).
  `unity-slot` uses the calls when it has a token; the game repo's `bench_queue.py` and `unity_slot.py` follow in their own
  pull request. Old branches' scripts run ungated (slots, still counted as processes) or in an ignored queue (bench, and
  the timing guard refuses their timings). Docs: unity-lifecycle.md ("Asking the daemon"). Tests: `daemonRpc.test.ts`.
