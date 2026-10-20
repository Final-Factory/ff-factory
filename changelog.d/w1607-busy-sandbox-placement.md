- New work never switches a busy sandbox's branch (w1607). On 2026-10-20 w1602's FF Factory worker was started beside
  w1440's worker in beast/slot1 with `extra_agent`, and its start switched the worktree under w1440's Unity batch build,
  because an earlier w1440 session had released that same branch. Now a start with `extra_agent`, or for a request on
  another repo, never switches the sandbox's branch; the hand-over of a released worker's branch skips a sandbox another
  worker is in or that is busy (a worker mid-turn, between turns with a build, test or bench running, or a bench lock held
  from its folder); and game work is refused beside a busy worker even with `extra_agent`.
