- **A request is no longer shown Stalled while a worker that holds it is busy** (w915, lothsahn: "Please fix the status
  labelling mixup to prevent that from happening in the future."). w909 read "Stalled (its worker moved on to w911)" while that
  worker was mid-turn on w909's own PR: the live state counted a worker as working only on the request it was last sent.
  A worker now holds every open request it was sent, until it reports DONE for it, sets it aside, or is asked to wrap it up and
  says nothing about it. Each shows Working while the worker is busy or has its own work going ("shared with w911"). A worker
  that writes `wNNN: paused: <why>` (in a wrap-up reply or any report) makes the request show the new **Paused** state
  ("worker on w911 first"); `wNNN: still open:` takes it up again. The wrap-up now asks about everything the worker holds, with
  the three answers. The ledger cleanup's stall pass reads the same hold: it never stalls, resumes or asks "Is it done?" about a
  request a busy worker holds or paused. `docs/orchestrators.md` "Ledger" has the rule; live at the next portal deploy.
