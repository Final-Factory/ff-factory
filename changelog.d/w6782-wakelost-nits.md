- A lost check-in's in-place wake (w6774) now skips only a request whose gate really holds its worker's resumes, as
  the resume itself would be held: one blocked only on a pair run's other leg, or with no gate left, is woken (w6782).
  The dispatcher's line for a held request no longer says FF Factory wakes the worker in place, and no wake is sent
  while a message already waits for that worker, so it is never delivered twice.
