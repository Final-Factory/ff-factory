- **A dispatcher or orchestrator stuck on a used-up Claude token is reported** (w5921; lothsahn: "Why was it hung without a
  decision? Why did it stall?"). Two turns in a row ending on Claude's usage limit send a `[token alert]` to the operators'
  orchestrators with the token (name and last four), its reset time and what was done; `system_status` and an undecided
  request's live state say "the dispatcher is rate-limited on <token> until <time>", and the 15-minute re-offer waits for the
  dispatcher to run again rather than going to the stuck process. Warn only: the dispatcher's own token switch follows in its
  own pull request. Needs a portal deploy.
