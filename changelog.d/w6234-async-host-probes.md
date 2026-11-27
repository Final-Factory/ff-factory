- **Host stats never hold the portal's event loop** (w6234): the GPU probe (nvidia-smi, or the Windows GPU counters) and
  a Mac's memory probe (vm_stat, sysctl) now start their programs on a worker thread of their own (`server/hostProbe.ts`).
  `hostStats` answers with each probe's last value at once, runs at most one of each at a time, and backs a probe that keeps
  timing out off to one try in 10 minutes (logged once). The asynchronous `execFile` was not enough: its spawn
  (CreateProcess) runs on the calling thread, and on a fully loaded BEAST (2026-11-26) Lens Scout's stall profiles showed
  `spawn` in `gpu` holding the loop for 2-38 s per 5 s refresh. A computer without nvidia-smi stops trying it after the
  first miss. Applies to the portal and every machine daemon (they share `hostStats`); needs a portal deploy and each
  daemon's update.
