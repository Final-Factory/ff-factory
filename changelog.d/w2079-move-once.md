- A resuming worker's move to a computer with room (w2046) starts exactly one new worker (w2079). On 2026-10-24 w1903's
  worker d5ab39da was moved twice in a minute (m5/slot3, then biscuit/slot2) while eca53c32 owned the request: the first
  move dropped the waiting resume, so the sweep resumed the old worker again, and its title still named the request, so
  that message moved it again. Now the sweep leaves a worker being moved alone, a move takes the request's gate resumes
  off the old worker, a worker already moved off a request is not moved for it again, and a request another live worker
  carries gets no moved copy at all (the old worker is taken off it and retired). A resume for a request its worker was
  moved off is dropped, so the old worker never takes the request up beside the new one.
- switch_branch and a sandbox's release no longer refuse forever when the branch's push is rejected because another
  worker pushed it meanwhile: the commits go to a backup branch `ff-backup/<branch>-<sha>` on origin, and the switch goes on.
