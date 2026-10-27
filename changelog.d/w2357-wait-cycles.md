- **A request and its timed leg no longer wait on each other forever (w2357):** A timed leg's report, a partial one too,
  resumes the request that filed it with that report; a report that says it waits on the request blocked on it clears
  that block; and the blocker watch finds wait cycles between requests (gates, and what an idle worker says it waits
  on), resumes the side that can act and logs `blocker watch: CYCLE`. A timed leg's brief now says its parent may resume
  in a new sandbox, so it takes both sides' commits from origin.
