- **Bench turns end on time, with a warning the worker sees** (w1832, lothsahn, 2026-10-23: "The harness should let workers
  run with the exclusive lock for at most 30 minutes. They should get a warning at 25 minutes"). The game repo's
  `bench_queue.py` now ends an exclusive turn at 30 minutes and a shared group an hour after its newest start, but only
  while another worker waits, after a 5-minute warning. The daemon reports each warned holder with its stats
  (`machine/benchWarnings.ts`) and the portal messages its worker once per deadline, with its checkout's uncommitted and
  unpushed work and the ask to push it (`server/benchWarnings.ts`). The portal marks the urgent release lane's builder
  and the scheduled nightly's worker exempt in `priorities.json` (`BenchPriority.exempt`), and a machine whose agent cap
  is 1 as `single_worker` (no limits there). Rolls out with the machines' daemon update.
