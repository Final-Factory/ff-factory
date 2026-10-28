- **A question about something visual reaches the Waiting tab only with a still or clip in it** (w2478). Ben, 2026-10-28:
  "i need to see previews. stop asking me questions in the intakes without showing my previews when applicable".
  `ask_person`, a worker's `waiting_on_person` and the dispatcher's `decide_work` ask now refuse a question on a request
  with review stills or clips (its own folders, a topic its workers published to, or files its last [needs you] named)
  unless the question or an option shows one inline. The ask_person check now reads the `request` field, not only ids in
  the words, and a repeated call no longer slips through; a question about nothing visual passes with
  `no_previews: "<why>"`, logged on the request. The [needs you] relay lists the request's review files, newest first, to
  inline.
