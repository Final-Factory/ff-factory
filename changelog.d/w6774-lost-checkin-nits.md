- A lost check-in (w6768) whose worker's computer is here again, or whose wake was refused at the agent limit, now wakes
  that worker where it is with the check-in's note, once, instead of reading Stalled until the dispatcher steps in; the
  dispatcher's message names that route (w6774). The fresh worker for a gone one is placed as `start_agent` places the
  request (workflows push, Live view, player build, timed run), never beside a `start_agent` already starting it, and its
  handover reads "Restarted (w6768): ... no longer exists" instead of "taken off ... on (removed)".
