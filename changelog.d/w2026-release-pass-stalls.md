- **The release pass and daemon connects stop holding the portal's event loop** (w2026, lothsahn: 735683ea0 was rolled back at
  11:37Z on 2026-10-24 for not answering /api/health within 300 s). The portal's own stall profiles (#651) named them: the
  release pass (every minute) computed a machine's claims again for every released worker, sorting every waiting worker each
  time, and asked every request about every worker (30-37 s of every minute); and the first connect of each daemon after the
  start unzipped every compressed transcript of its sessions whole on the main thread to write its tail file (39 s). Claims are
  now computed once per machine per pass, the requests are indexed by worker for the pass, `isWith` skips its sort for
  workers not on the request, and a connect unzips off the main thread before its welcome (`Store.lastSeqAsync`).
