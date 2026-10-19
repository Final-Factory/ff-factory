- A worker's "waiting on <person>" (its report's still-open line or its `waiting_on_person`) counts only until that person
  answers the request (a note or a `[needs you]` answer) or a pull request it names merges, and a request Blocked on a
  thing shows Blocked unless the person-wait is newer than its gates. The sandbox's "Needs you" badge and the `[needs you]`
  sends clear by the same rule. Sessions record `lastResultAt`; the store fills it in from transcripts for open requests'
  workers (w1504, w1243).
